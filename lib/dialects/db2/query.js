'use strict';

const logger = require('../../utils/logger');
const Promise = require('../../promise');
const AbstractQuery = require('../abstract/query');
const sequelizeErrors = require('../../errors');
const parserStore = require('../parserStore')('db2');
const _ = require('lodash');
const moment = require('moment');
const debug = logger.getLogger().debugContext('sql:db2');

class Query extends AbstractQuery {
  constructor(connection, sequelize, options) {
    super();
    this.connection = connection;
    this.instance = options.instance;
    this.model = options.model;
    this.sequelize = sequelize;
    this.options = _.extend({
      logging: console.log,
      plain: false,
      raw: false
    }, options || {});

    this.checkLoggingOption();
  }

  getInsertIdField() {
    return 'id';
  }

  getSQLTypeFromJsType(value) {
    const param = {ParamType:"INPUT", Data: value};
    if (Buffer.isBuffer(value)) {
      param.DataType = "BLOB";
      return param;
    }
    return value;
  }

  _run(connection, sql, parameters) {
    this.sql = sql;

    //do we need benchmark for this query execution
    const benchmark = this.sequelize.options.benchmark || this.options.benchmark;
    let queryBegin;
    if (benchmark) {
      queryBegin = Date.now();
    } else {
      this.sequelize.log('Executing (' + (this.connection.uuid || 'default') + '): ' + this.sql, this.options);
    }

    debug(`executing(${this.connection.uuid || 'default'}) : ${this.sql}`);

    return new Promise((resolve, reject) => {
      // TRANSACTION SUPPORT
      if (_.startsWith(this.sql, 'BEGIN TRANSACTION')) {
        connection.beginTransaction(err => {
          if (err) {
            reject(this.formatError(err));
          } else {
            resolve(this.formatResults());
          }
        });
      } else if (_.startsWith(this.sql, 'COMMIT TRANSACTION')) {
        connection.commitTransaction(err => {
          if (err) {
            reject(this.formatError(err));
          } else {
            resolve(this.formatResults());
          }
        });
      } else if (_.startsWith(this.sql, 'ROLLBACK TRANSACTION')) {
        connection.rollbackTransaction(err => {
          if (err) {
            reject(this.formatError(err));
          } else {
            resolve(this.formatResults());
          }
        });
      } else if (_.startsWith(this.sql, 'SAVE TRANSACTION')) {
        connection.commitTransaction(err => {
          if (err) {
            reject(this.formatError(err));
          } else {
            connection.beginTransaction(err => {
              if (err) {
                reject(this.formatError(err));
              } else {
                resolve(this.formatResults());
              }
            });
          }
        }, this.options.transaction.name);
      } else {
        const results = [];
        let params = [];
        if (parameters) {
          _.forOwn(parameters, (value, key) => {
            const param = this.getSQLTypeFromJsType(value);
            params.push(param);
          });
        }

        if (this.isSelectQuery() && this.sql.indexOf(' FROM ', 8) === -1) {
          if (this.sql.charAt(this.sql.length -1) === ';') {
              this.sql = this.sql.slice(0, this.sql.length - 1);
          }
          this.sql += ' FROM SYSIBM.SYSDUMMY1';
        }

        connection.prepare(this.sql, (err, stmt) => {
          if(err) { reject(this.formatError(err)); }
          stmt.execute(params, (err, result, outparams) => {
            debug(`executed(${this.connection.uuid || 'default'}):${this.sql}`);

            if (benchmark) {
              this.sequelize.log('Executed (' + (this.connection.uuid || 'default') + '): ' + this.sql, Date.now() - queryBegin, this.options);
            }

            if (err && err.message) {
              if(err.message.search("SQL0204N") != -1 &&
                 _.startsWith(this.sql, 'DROP ')) {
                err = null; // Ignore table not found error for drop table.
              } else if(err.message.search("SQL0443N") != -1) {
                err = null; // Ignore drop schema error.
              } else if(err.message.search("SQL0601N") != -1) {
                err = null; // Ignore create table error.
              } else if(err.message.search("SQL0911N") != -1) {
                if(err.message.search('Reason code "2"') != -1) {
                  err = null; // Ignore deadlock error due to program logic.
                }
              } else if(err.message.search("SQL0605W") != -1) {
                //warn(err.message);
                err = null; // Ignore warning.
              }
              if(err === null) {
                resolve(this.formatResults([], 0));
              }
            }
            if (err) {
              err.sql = sql;
              stmt.closeSync();
              reject(this.formatError(err, connection, parameters));
            } else {
              let data = [];
              let metadata = [];
              let affectedRows = 0;
              if(typeof(result) === 'object') {
                if (_.startsWith(this.sql, 'DELETE FROM ')) {
                    affectedRows = result.getAffectedRowsSync();
                } else {
                  data = result.fetchAllSync();
                  metadata = result.getColumnMetadataSync();
                }
                result.closeSync();
              }
              stmt.closeSync();
              const datalen = data.length;
              if(datalen > 0) {
                let coltypes = {};
                for (let i = 0; i < metadata.length; i++) {
                  coltypes[metadata[i].SQL_DESC_CONCISE_TYPE] =
                      metadata[i].SQL_DESC_TYPE_NAME;
                }
                for(let i = 0; i < datalen; i++) {
                  for(const column in data[i]) {
                    const parse = parserStore.get(coltypes[column]);
                    let value = data[i][column];
                    if (value !== null) {
                      if(!!parse) {
                        data[i][column] = parse(value);
                      } else if(coltypes[column] === 'TIMESTAMP') {
                        data[i][column] = new Date(moment.utc(value));
                      } else if(coltypes[column] === 'BLOB') {
                        data[i][column] = new Buffer(value);
                      } else if(coltypes[column].indexOf('FOR BIT DATA') > 0) {
                        data[i][column] = new Buffer(value, "hex");
                      }
                    }
                  }
                }
                resolve(this.formatResults(data, datalen, metadata,connection));
              } else {
                resolve(this.formatResults(data, affectedRows));
              }
            }
          });
        });
      }
    });
  }

  run(sql, parameters) {
    return Promise.using(this.connection.lock(), connection => this._run(connection, sql, parameters));
  }

  static formatBindParameters(sql, values, dialect) {
    let bindParam = {};
    const replacementFunc = (match, key, values) => {
      if (values[key] !== undefined) {
        bindParam[key] = values[key];
        return '?';
      }
      return undefined;
    };
    sql = AbstractQuery.formatBindParameters(sql, values, dialect, replacementFunc)[0];
    if(Array.isArray(values) && typeof(values[0]) === 'object') {
        bindParam = values;
    }

    return [sql, bindParam];
  }

  /**
   * High level function that handles the results of a query execution.
   *
   *
   * Example:
   *  query.formatResults([
   *    {
   *      id: 1,              // this is from the main table
   *      attr2: 'snafu',     // this is from the main table
   *      Tasks.id: 1,        // this is from the associated table
   *      Tasks.title: 'task' // this is from the associated table
   *    }
   *  ])
   *
   * @param {Array} data - The result of the query execution.
   * @private
   */
  formatResults(data, rowCount, metadata, conn) {
    let result = this.instance;
    if (this.isInsertQuery(data, metadata)) {
      this.handleInsertQuery(data, metadata);

      if (!this.instance) {
        if (this.options.plain) {
          const record = data[0];
          result = record[Object.keys(record)[0]];
        } else {
          result = data;
        }
      }
    }

    if (this.isShowTablesQuery()) {
      result = this.handleShowTablesQuery(data);
    } else if (this.isDescribeQuery()) {
      result = {};
      for (const _result of data) {
        if (_result.Default) {
          _result.Default = _result.Default.replace("('", '').replace("')", '').replace(/'/g, '');
        }

        result[_result.Name] = {
          type: _result.Type.toUpperCase(),
          allowNull: _result.IsNull === 'Y' ? true : false,
          defaultValue: _result.Default,
          primaryKey: _result.KeySeq > 0,
          autoIncrement: _result.IsIdentity === 'Y' ? true : false,
          comment: _result.Comment
        };
      }
    } else if (this.isShowIndexesQuery()) {
      result = this.handleShowIndexesQuery(data);
    } else if (this.isSelectQuery()) {
      result = this.handleSelectQuery(data);
    } else if (this.isUpsertQuery()) {
      result = data[0];
    } else if (this.isDropSchemaQuery()) {
      result = data[0];
      if (conn) {
        let query = "DROP TABLE ERRORSCHEMA.ERRORTABLE";
        conn.querySync(query);
      }
    } else if (this.isCallQuery()) {
      result = data[0];
    } else if (this.isBulkUpdateQuery()) {
      result = data.length;
    } else if (this.isBulkDeleteQuery()) {
      result = rowCount;
    } else if (this.isVersionQuery()) {
      result = data;
    } else if (this.isForeignKeysQuery()) {
      result = data;
    } else if (this.isInsertQuery() || this.isUpdateQuery()) {
      result = [result, rowCount];
    } else if (this.isShowConstraintsQuery()) {
      result = this.handleShowConstraintsQuery(data);
    } else if (this.isRawQuery()) {
      // Db2 returns row data and metadata (affected rows etc) in a single object - let's standarize it, sorta
      result = [data, metadata];
    }

    return result;
  }

  handleShowTablesQuery(results) {
    return results.map(resultSet => {
      return {
        tableName: resultSet.tableName,
        schema: resultSet.tableSchema
      };
    });
  }

  handleShowConstraintsQuery(data) {
    // Remove SQL Contraints from constraints list.
    return _.remove(data, constraint => {
      return !( _.startsWith(constraint.constraintName, 'SQL'));
    });
  }

  formatError(err, conn, parameters) {
    let match;

    if(!(err || err.message)) {
        err["message"] = "No error message found.";
    }

    match = err.message.match(/SQL0803N  One or more values in the INSERT statement, UPDATE statement, or foreign key update caused by a DELETE statement are not valid because the primary key, unique constraint or unique index identified by "(\d)+" constrains table "(.*)\.(.*)" from having duplicate values for the index key./);
    if (match && match.length > 0) {
      let uniqueIndexName = "";
      let uniqueKey = "";
      let dataValues = null;
      let fields = {};
      let message = err.message;
      const query = 'SELECT INDNAME FROM SYSCAT.INDEXES  WHERE IID = ' +
                  match[1] + " AND TABSCHEMA = '" + match[2] +
                  "' AND TABNAME = '" + match[3] + "'";

      if( !!conn && match.length > 3 ) {
          uniqueIndexName = conn.querySync(query);
          uniqueIndexName = uniqueIndexName[0]['INDNAME'];
      }

      if(this.model && !!uniqueIndexName) {
          uniqueKey = this.model.uniqueKeys[uniqueIndexName];
      }

      if (!uniqueKey && this.options.fields) {
          uniqueKey = this.options.fields[match[1] - 1];
      }

      if(!!uniqueKey) {
        if(this.options.where &&
           this.options.where[uniqueKey.column] !== undefined) {
          fields[uniqueKey.column] = this.options.where[uniqueKey.column];
        } else if (this.options.instance && this.options.instance.dataValues &&
                   this.options.instance.dataValues[uniqueKey.column]) {
          fields[uniqueKey.column] = this.options.instance.dataValues[uniqueKey.column];
        } else if (parameters) {
          fields[uniqueKey.column] = parameters['0'];
        }
      }

      if (uniqueKey && !!uniqueKey.msg) {
        message = uniqueKey.msg;
      }

      const errors = [];
      _.forOwn(fields, (value, field) => {
        errors.push(new sequelizeErrors.ValidationErrorItem(
          this.getUniqueConstraintErrorMessage(field),
          'unique violation', // sequelizeErrors.ValidationErrorItem.Origins.DB,
          field,
          value,
          this.instance,
          'not_unique'
        ));
      });

      return new sequelizeErrors.UniqueConstraintError({ message, errors, parent: err, fields });
    }

    match = err.message.match(/SQL0532N  A parent row cannot be deleted because the relationship "(.*)" restricts the deletion/) ||
      err.message.match(/SQL0530N/) ||
      err.message.match(/SQL0531N/) ;
    if (match && match.length > 0) {
      return new sequelizeErrors.ForeignKeyConstraintError({
        fields: null,
        index: match[1],
        parent: err
      });
    }

    match = err.message.match(/SQL0204N  "(.*)" is an undefined name./);
    if (match && match.length > 1) {
      let constraint = match[1];
      let table = err.sql.match(/table "(.+?)"/i);
      table = table ? table[1] : undefined;

      return new sequelizeErrors.UnknownConstraintError({
        message: match[0],
        constraint,
        table,
        parent: err
      });
    }

    return new sequelizeErrors.DatabaseError(err);
  }

  isDropSchemaQuery() {
    let result = false;

    if (_.startsWith(this.sql, 'CALL SYSPROC.ADMIN_DROP_SCHEMA')) {
        result = true;
    }
    return result;
  }

  isShowOrDescribeQuery() {
    let result = false;

    result = result || this.sql.toLowerCase().indexOf("select c.column_name as 'name', c.data_type as 'type', c.is_nullable as 'isnull'") === 0;
    result = result || this.sql.toLowerCase().indexOf('select tablename = t.name, name = ind.name,') === 0;
    result = result || this.sql.toLowerCase().indexOf('exec sys.sp_helpindex @objname') === 0;

    return result;
  }

  handleShowIndexesQuery(data) {
    // Group by index name, and collect all fields
    data = _.reduce(data, (acc, item) => {
      if (!(item.name in acc)) {
        acc[item.name] = item;
        item.fields = [];
      }

      // item.COLNAMES = '+fieldB-fieldA', '+fieldB', '-fieldA'
      _.forEach(item.COLNAMES.replace('+', ' +').replace('-', ' -').split(' '), column => {
        let columnName = column.trim();
        if( columnName ) {
          columnName = columnName.replace('-', '').replace('+', '');

          acc[item.name].fields.push({
            attribute: columnName,
            length: undefined,
            order: column.indexOf('-') === -1 ? 'ASC' : 'DESC',
            collate: undefined
          });
        }
      });
      delete item.COLNAMES;
      return acc;
    }, {});

    return _.map(data, item => ({
      primary: item.keyType === 'P' ? true : false,
      fields: item.fields,
      name: item.name,
      tableName: item.tableName,
      unique: item.keyType === 'U' ? true : false,
      type: item.type
    }));
  }

  handleInsertQuery(results, metaData) {
    if (this.instance) {
      // add the inserted row id to the instance
      const autoIncrementAttribute = this.model.autoIncrementAttribute;
      let id = null;
      let autoIncrementAttributeAlias = null;

      if (this.model.rawAttributes.hasOwnProperty(autoIncrementAttribute) &&
        this.model.rawAttributes[autoIncrementAttribute].field !== undefined)
        autoIncrementAttributeAlias = this.model.rawAttributes[autoIncrementAttribute].field;

      id = id || results &&  results[0] && results[0][this.getInsertIdField()];
      id = id || metaData && metaData[this.getInsertIdField()];
      id = id || results &&  results[0] && results[0][autoIncrementAttribute];
      id = id || autoIncrementAttributeAlias && results && results[0] && results[0][autoIncrementAttributeAlias];

      this.instance[autoIncrementAttribute] = id;
    }
  }
}

module.exports = Query;
module.exports.Query = Query;
module.exports.default = Query;
