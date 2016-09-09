// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2016 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

require('thingengine-core/lib/polyfill');

const Q = require('q');
const fs = require('fs');
const byline = require('byline');

const db = require('../util/db');
const schema = require('../model/schema');
const exampleModel = require('../model/example');

// A copy of ThingTalk SchemaRetriever
// that uses schema.getDeveloperMetas instead of ThingPediaClient
// (and also ignore builtins)
class SchemaRetriever {
    constructor(dbClient, language) {
        this._metaRequest = null;
        this._pendingMetaRequests = [];
        this._metaCache = {};

        this._dbClient = dbClient;
        this._language = language;
    }

    _ensureMetaRequest() {
        if (this._metaRequest !== null)
            return;

        this._metaRequest = Q.delay(0).then(() => {
            var pending = this._pendingMetaRequests;
            this._pendingMetaRequests = [];
            this._metaRequest = null;
            console.log('Batched schema-meta request for ' + pending);
            return schema.getDeveloperMetas(this._dbClient, pending, this._language);
        }).then((rows) => {
            rows.forEach((row) => {
                this._metaCache[row.kind] = {
                    triggers: row.triggers,
                    actions: row.actions,
                    queries: row.queries
                };
            });
            return this._metaCache;
        });
    }

    _getFullMeta(kind) {
        if (kind in this._metaCache)
            return Q(this._metaCache[kind]);

        if (this._pendingMetaRequests.indexOf(kind) < 0)
            this._pendingMetaRequests.push(kind);
        this._ensureMetaRequest();
        return this._metaRequest.then(function(everything) {
            if (kind in everything)
                return everything[kind];
            else
                throw new Error('Invalid kind ' + kind);
        });
    }

    getMeta(kind, where, name) {
        return this._getFullMeta(kind).then((fullSchema) => {
            if (!(name in fullSchema[where]))
                throw new Error("Schema " + kind + " has no " + where + " " + name);
            return fullSchema[where][name];
        });
    }
}

var _schemaRetriever;

// these need to match the grammar tokens that SEMPRE uses
const GRAMMAR_TOKENS = {
    en: {
        'true': 'true',
        'false': 'false',
        'one': 'one',
        'here': 'here',
        'at_work': 'at work',
        'at_home': 'at home',
        'is': 'is',
        'contains': 'contains',
        'has': 'has',
        'is greater than': 'is greater than',
        'is less than': 'is less than',
        'with': 'with',
        'and': 'and',
        'monitor_if': 'monitor if',
        'every_day_at': 'every day at',
        'every': 'every',
        'if': 'if',
        'then': 'then',
        'help': 'help',
        'discover': 'discover',
        'configure': 'configure',
        'devices': 'devices',
        'queries': 'queries',
        'commands': 'commands',
        'list': 'list',
        'yes': 'yes',
        'no': 'no',
        'hello': 'hello',
        'thanks': 'thanks',
        'sorry': 'sorry',
        'cool': 'cool',
        'never_mind': 'never mind'
    },
    it: {
        'true': 'vero',
        'false': 'falso',
        'one': 'uno',
        'here': 'qui',
        'at_work': 'al lavoro',
        'at_home': 'a casa',
        'is': 'è',
        'contains': 'contiene',
        'has': 'ha',
        'is greater than': 'è maggiore di',
        'is less than': 'è minore di',
        'with': 'con',
        'and': 'e',
        'monitor_if': 'osserva se',
        'every_day_at': 'ogni giorno alle',
        'every': 'ogni',
        'if': 'se',
        'then': 'allora',
        'help': 'aiuto',
        'discover': 'ricerca',
        'configure': 'configura',
        'devices': 'dispositivi',
        'queries': 'interrogazioni',
        'commands': 'comandi',
        'list': 'lista',
        'yes': 'sì',
        'no': 'no',
        'hello': 'ciao',
        'thanks': 'grazie',
        'sorry': 'scusa',
        'cool': 'figo',
        'never_mind': 'lascia stare'
    },
    zh: {
        'true': "正确",
        'false': "错误",
        'one': "一",
        'here': "这里",
        'at_work': "在 公司",
        'at_home': "在 家",
        'is': "是",
        'contains': "包含",
        'has': "有",
        'is greater than': "大于",
        'is less than': "少于",
        'with': "把",
        'and': "和",
        'monitor_if': "监控 如果",
        'every_day_at': "每天 在",
        'every': "每",
        'if': "如果",
        'then': "就",
        'help': "帮助",
        'discover': "搜索",
        'configure': "设置",
        'devices': "设备",
        'queries': "查询",
        'commands': "命令",
        'list': "列出",
        'yes': "是",
        'no': "否",
        'hello': "你好",
        'thanks': "谢谢",
        'sorry': "对不起",
        'cool': "酷",
        'never_mind': "算了"
    }
}

const SPECIAL_TO_GRAMMAR = {
    hello: 'hello',
    debug: 'debug',
    help: 'help',
    thankyou: 'thanks',
    sorry: 'sorry',
    cool: 'cool',
    nevermind: 'never_mind',
    failed: 'failuretoparse',
    yes: 'yes',
    no: 'no'

}
const COMMAND_TO_GRAMMAR = {
    configure: 'configure',
    list: 'list',
    discover: 'discover',
    help: 'help'
};
const LIST_TO_GRAMMAR = {
    device: 'devices',
    query: 'queries',
    command: 'commands',
}

function argToCanonical(grammar, buffer, arg) {
    if (arg.type === 'Location') {
        if (arg.value.relativeTag === 'rel_current_location')
            buffer.push(grammar.here);
        else if (arg.value.relativeTag === 'rel_home')
            buffer.push(grammar.at_home);
        else if (arg.value.relativeTag === 'rel_work')
            buffer.push(grammar.at_work);
        else if (arg.value.latitude === 37.442156 && arg.value.longitude === -122.1634471)
            buffer.push('palo alto');
        else if (arg.value.latitude === 34.0543942 && arg.value.longitude === -118.2439408)
            buffer.push('los angeles');
        else {
            console.log('Unknown location at ' + arg.value.latitude + ', ' + arg.value.longitude);
            buffer.push('some other place');
        }
    } else if (arg.type === 'String') {
        buffer.push("``");
        buffer.push(arg.value.value);
        buffer.push("''");
    } else if (arg.type === 'Boolean') {
        buffer.push(grammar[String(arg.value.value)]);
    } else if (arg.type === 'Date') {
        buffer.push('%04d/%02d/%02d'.format(arg.value.year, arg.value.month, arg.value.day));
    } else if (arg.type === 'Time') {
        buffer.push('%02d:%02d'.format(arg.value.hour, arg.value.minute));
    } else {
        buffer.push(String(arg.value.value));
        if (arg.type === 'Measure')
            buffer.push(arg.value.unit || arg.unit);
    }
}

function invocationToCanonical(invocation, meta, grammar, buffer) {
    var name = invocation.name;
    var args = invocation.args;
    buffer.push(meta.canonical);

    var argmap = {};
    meta.argcanonicals.forEach(function(argcanonical, i) {
        argmap[meta.args[i]] = argcanonical || meta.args[i];
    });

    args.forEach(function(arg) {
        buffer.push(grammar.with);
        buffer.push('arg');

        var match = /^tt[:\.]param\.(.+)$/.exec(arg.name.id);
        if (match === null) {
            throw new TypeError('Argument name not in proper format, is ' + arg.name.id);
        }
        var argname = match[1];

        var argcanonical;
        if (argname in argmap)
            argcanonical = argmap[argname];
        else
            argcanonical = argname.replace(/_/g, ' ').replace(/([^A-Z])([A-Z])/g, '$1 $2').toLowerCase();
        buffer.push(argcanonical);

        if (arg.operator === '<')
            buffer.push(grammar.is_less_than);
        else if (arg.operator === '>')
            buffer.push(grammar.is_greater_than);
        else
            buffer.push(grammar[arg.operator]);
        argToCanonical(grammar, buffer, arg);
    });
}

function getMeta(invocation, schemaType) {
    var match = /^tt:([^\.]+)\.(.+)$/.exec(invocation.name.id);
    if (match === null)
        throw new TypeError('Channel name not in proper format');
    var kind = match[1];
    var channelName = match[2];
    return _schemaRetriever.getMeta(kind, schemaType, channelName);
}

function reconstructCanonical(dbClient, grammar, language, json) {
    var parsed = JSON.parse(json);

    if (parsed.special) {
        var token = SPECIAL_TO_GRAMMAR[parsed.special.id.substr('tt:root.special.'.length)];
        if (token === 'failuretoparse' || token === 'debug')
            return token;
        else
            return grammar[token];
    }

    var buffer = [];
    if (parsed.command) {
        buffer.push(grammar[COMMAND_TO_GRAMMAR[parsed.command.type]]);

        if (parsed.command.value.value === 'generic')
            return buffer.join(' ');
        if (parsed.command.type === 'configure' || parsed.command.type === 'help' ||
            parsed.command.type === 'discover') {
            buffer.push(parsed.command.value.id.substr('tt:device.'.length));
        } else {
            buffer.push(grammar[LIST_TO_GRAMMAR[parsed.command.value.value]]);
        }
        return buffer.join(' ');
    }
    if (parsed.answer) {
        argToCanonical(grammar, buffer, parsed.answer);
        return buffer.join(' ');
    }

    if (parsed.trigger)
        buffer.push(grammar.monitor_if);

    var trigger = null, action = null, query = null;
    var triggerMeta = null, actionMeta = null, queryMeta = null;

    var name, args, schemaType;
    if (parsed.action) {
        action = parsed.action;
        actionMeta = getMeta(parsed.action, 'actions');
    } else if (parsed.query) {
        query = parsed.query;
        queryMeta = getMeta(parsed.query, 'queries');
    } else if (parsed.trigger) {
        trigger = parsed.trigger;
        triggerMeta = getMeta(parsed.trigger, 'triggers');
    } else if (parsed.rule) {
        if (parsed.rule.action) {
            action = parsed.rule.action;
            actionMeta = getMeta(parsed.rule.action, 'actions');
        }
        if (parsed.rule.query) {
            query = parsed.rule.query;
            queryMeta = getMeta(parsed.rule.query, 'queries');
        }
        if (parsed.rule.trigger) {
            trigger = parsed.rule.trigger;
            triggerMeta = getMeta(parsed.rule.trigger, 'triggers');
        }
    } else {
        throw new TypeError('Not action, query, trigger or rule');
    }

    return Q.all([triggerMeta, actionMeta, queryMeta]).spread(function(triggerMeta, actionMeta, queryMeta) {
        if (parsed.rule) {
            if (parsed.rule.trigger) {
                if (parsed.rule.trigger.name.id === 'tt:builtin.timer' &&
                    parsed.rule.trigger.args.length === 1 &&
                    parsed.rule.trigger.args[0].name.id === 'tt:param.interval') {
                    buffer.push(grammar.every);
                    argToCanonical(grammar, buffer, parsed.rule.trigger.args[0]);
                } else if (parsed.rule.trigger.name.id === 'tt:builtin.at' &&
                           parsed.rule.trigger.args.length === 1 &&
                           parsed.rule.trigger.args[0].name.id === 'tt:param.time') {
                    buffer.push(grammar.every_day_at);
                    argToCanonical(grammar, buffer, parsed.rule.trigger.args[0]);
                } else {
                    buffer.push(grammar['if']);
                    invocationToCanonical(parsed.rule.trigger, triggerMeta, grammar, buffer);
                    buffer.push(grammar.then);
                }
            }
            if (parsed.rule.query)
                invocationToCanonical(parsed.rule.query, queryMeta, grammar, buffer);
            if (parsed.rule.query && parsed.rule.action)
                buffer.push(grammar.then);
            if (parsed.rule.action)
                invocationToCanonical(parsed.rule.action, actionMeta, grammar, buffer);
        } else if (parsed.action) {
            invocationToCanonical(parsed.action, actionMeta, grammar, buffer);
        } else if (parsed.query) {
            invocationToCanonical(parsed.query, queryMeta, grammar, buffer);
        } else if (parsed.trigger) {
            buffer.push(grammar.monitor_if);
            invocationToCanonical(parsed.trigger, triggerMeta, grammar, buffer);
        }

        return buffer.join(' ');
    });
}

function main() {
    var output = fs.createWriteStream(process.argv[2]);
    var onlineLearn = process.argv.length >= 4 ? byline(fs.createReadStream(process.argv[3])) : null;
    if (onlineLearn !== null)
        onlineLearn.setEncoding('utf8');

    var language = process.argv[4] || 'en';
    var grammar = GRAMMAR_TOKENS[language];
    if (!grammar)
        throw new Error('Invalid language ' + language);

    db.withClient((dbClient) => {
        _schemaRetriever = new SchemaRetriever(dbClient, language);
        var promises = [];

        return exampleModel.getAllWithLanguage(dbClient, language).then((examples) => {
            examples.forEach((ex) => {
                if (ex.is_base)
                    return;

                promises.push(Q.try(function() {
                    return reconstructCanonical(dbClient, grammar, language, ex.target_json);
                }).then(function(reconstructed) {
                    output.write(ex.utterance);
                    output.write('\t');
                    output.write(reconstructed);
                    output.write('\n');
                }).catch((e) => {
                    console.error('Failed to handle ' + ex.utterance + ': ' + e.message);
                }));
            });
        }).then(() => {
            if (onlineLearn === null) {
                return;
            }

            return Q.Promise(function(callback, errback) {
                onlineLearn.on('data', (data) => {
                    var line = data.split(/\t/);
                    var utterance = line[0];
                    var target_json = line[1];
                    promises.push(Q.try(function() {
                        return reconstructCanonical(dbClient, grammar, language, target_json);
                    }).then(function(reconstructed) {
                        output.write(utterance);
                        output.write('\t');
                        output.write(reconstructed);
                        output.write('\n');
                    }).catch((e) => {
                        console.error('Failed to handle ' + utterance + ': ' + e.message);
                    }));
                });

                onlineLearn.on('end', () => callback());
                onlineLearn.on('error', errback);
            });
        }).then(function() {
            return Q.all(promises);
        });
    }).finally(() => {
        output.end();
    });

    output.on('finish', () => process.exit());
}
main();
