'use strict';

var utils = require('../shared/utils');
var clientUtils = require('./utils');
var uuid = require('./../shared/uuid');
var errors = require('../shared/errors');
var log = require('debug')('pouchdb:socket:client');
var Socket = require('engine.io-client');
var blobUtil = require('blob-util');
var isBrowser = typeof process === 'undefined' || process.browser;
var buffer = require('../shared/buffer');
var preprocessAttachments = clientUtils.preprocessAttachments;
var stringifyArgs = clientUtils.stringifyArgs;
var padInt = clientUtils.padInt;
var adapterFun = clientUtils.adapterFun;

var instances = {};

function close(api, callback) {
  log('closing socket', api._socketId, api._name);

  function closeSocket() {
    api._socket.closed = true;
    api._socket.once('close', function (msg) {
      log('socket closed', api._socketId, msg);
      api._socket.removeAllListeners();
      callback();
    });
    api._socket.close();
  }

  if (api._socket.closed) {
    return callback();
  }
  closeSocket();
}

// Implements the PouchDB API for dealing with CouchDB instances over WS
function SocketPouch(opts, callback) {
  var api = this;

  if (typeof opts === 'string') {
    var slashIdx = utils.lastIndexOf(opts, '/');
    opts = {
      url: opts.substring(0, slashIdx),
      name: opts.substring(slashIdx + 1)
    };
  } else {
    opts = utils.clone(opts);
  }

  log('constructor called', opts);

  if (!opts.url || !opts.name) {
    var optsErrMessage = 'Error: you must provide a web socket ' +
      'url and database name.';
    console.error(optsErrMessage);
    return callback(new Error(optsErrMessage));
  }

  api.skipDependentDatabase = true;

  var cacheKey = '$' + opts.originalName;

  function useExistingSocket() {
    // Re-use the cached one instead of creating multiple sockets.
    // This is important, because if a user creates many PouchDBs
    // without closing/destroying each one, then we could end up
    // with too many open sockets, which causes problems like
    // https://github.com/Automattic/engine.io/issues/320
    var instance = instances[cacheKey];
    api._socket = instance._socket;
    api._callbacks = instance._callbacks;
    api._changesListeners = instance._changesListeners;
    api._blobs = instance._blobs;
    api._binaryMessages = instance._binaryMessages;
    api._name = instance._name;

    if (instance._socketId) {
      api._socketId = instance._socketId;
      process.nextTick(function () {
        callback(null, api);
      });
    } else {
      api._socket.once('open', function () {
        api._socketId = api._socket.id;
        process.nextTick(function () {
          callback(null, api);
        });
      });
    }
  }

  function createNewSocket() {
    var socket = api._socket = new Socket(opts.url, opts.socketOptions || {});
    socket.binaryType = 'blob';
    api._callbacks = {};
    api._changesListeners = {};
    api._blobs = {};
    api._binaryMessages = {};
    api._name = opts.originalName;
    instances[cacheKey] = api;

    socket.once('open', function () {
      api._socketId = socket.id;
      log('socket opened', api._socketId, api._name);
      sendMessage('createDatabase', [{
        name: api._name,
        auto_compaction: !!opts.auto_compaction
      }], function (err) {
        if (err) {
          return callback(err);
        }
        callback(null, api);
      });
    });

    api._socket.once('error', function (err) {
      callback(err);
    });

    function receiveMessage(res) {
      var split = utils.parseMessage(res, 3);
      var messageId = split[0];
      var messageType = split[1];
      var content = JSON.parse(split[2]);
      var cb = api._callbacks[messageId];

      if (!cb) {
        log('duplicate message (ignoring)', messageId, messageType, content);
        return;
      }

      log('receive message', api._socketId, messageId, messageType, content);

      if (messageType === '0') { // error
        delete api._callbacks[messageId];
        cb(content);
      } else if (messageType === '1') { // success
        delete api._callbacks[messageId];
        cb(null, content);
      } else if (messageType === '2') { // update, i.e. changes
        api._changesListeners[messageId](content);
      } else { // binary success
        delete api._callbacks[messageId];
        receiveBinaryMessage(content, cb);
      }
    }

    function receiveBinaryMessage(content, cb) {
      log('receiveBinaryMessage', content.uuid);
      api._binaryMessages[content.uuid] = {
        contentType: content.type,
        cb: cb
      };
      checkBinaryReady(uuid);
    }

    function receiveBlob(blob) {
      if (isBrowser) {
        blobUtil.blobToBinaryString(blob.slice(0, 36)).then(function (uuid) {
          api._blobs[uuid] = blob.slice(36);
          log('receiveBlob', uuid);
          checkBinaryReady(uuid);
        }).catch(console.log.bind(console));
      } else {
        var uuid = blob.slice(0, 36).toString('utf8');
        log('receiveBlob', uuid);
        api._blobs[uuid] = blob.slice(36);
        checkBinaryReady(uuid);
      }
    }

    // binary messages come in two parts; wait until we've received both
    function checkBinaryReady(uuid) {
      if (!(uuid in api._blobs && uuid in api._binaryMessages)) {
        return;
      }
      log('receive full binary message', uuid);
      var blob = api._blobs[uuid];
      var msg = api._binaryMessages[uuid];

      delete api._blobs[uuid];
      delete api._binaryMessages[uuid];

      var blobToDeliver;
      if (isBrowser) {
        blobToDeliver = blobUtil.createBlob([blob], {type: msg.contentType});
      } else {
        blobToDeliver = blob;
      }

      msg.cb(null, blobToDeliver);
    }

    api._socket.on('message', function (res) {
      if (typeof res !== 'string') {
        return receiveBlob(res);
      }
      receiveMessage(res);
    });
  }

  if (instances[cacheKey]) {
    useExistingSocket();
  } else { // new DB
    createNewSocket();
  }

  function sendMessage(type, args, callback) {
    var messageId = uuid();
    log('send message', api._socketId, messageId, type, args);
    api._callbacks[messageId] = callback;
    var stringArgs = stringifyArgs(args);
    api._socket.send(type + ':' + messageId + ':' + stringArgs, function () {
      log('message sent', api._socketId, messageId);
    });
  }

  function sendBinaryMessage(type, args, blobIndex, blob, callback) {
    var messageId = uuid();
    api._callbacks[messageId] = callback;
    var header = {
      args: args,
      blobIndex: blobIndex,
      messageId: messageId,
      messageType: type
    };

    log('send binary message', api._socketId, messageId, header);
    var headerString = JSON.stringify(header);
    var headerLen = padInt(headerString.length, 16);
    var blobToSend;
    if (isBrowser) {
      blobToSend = blobUtil.createBlob([
        headerLen,
        headerString,
        blob
      ]);
    } else { // node.js
      blobToSend = buffer.concat([
        new buffer(headerLen, 'utf8'),
        new buffer(headerString, 'utf8'),
        new buffer(blob, 'binary')
      ]);
    }
    api._socket.send(blobToSend, function () {
      log('binary message sent', api._socketId, messageId);
    });
  }

  api.type = function () {
    return 'socket';
  };

  api._id = adapterFun('id', function (callback) {
    sendMessage('id', [], callback);
  });

  api.compact = adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('compact', [opts], callback);
  });

  api._info = function (callback) {
    sendMessage('info', [], callback);
  };

  api.get = adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('get', [id, opts], callback);
  });

  api.remove =
    adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
      var doc;
      if (typeof optsOrRev === 'string') {
        // id, rev, opts, callback style
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        // doc, opts, callback style
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }
      var rev = (doc._rev || opts.rev);

      sendMessage('remove', [doc._id, rev], callback);
  });

  api.getAttachment =
    adapterFun('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      sendMessage('getAttachment', [docId, attachmentId, opts], callback);
  });

  api.removeAttachment =
    adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

      sendMessage('removeAttachment', [docId, attachmentId, rev], callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun('putAttachment', function (docId, attachmentId, rev, blob,
                                                type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      if (typeof type === 'undefined') {
        type = blob;
        blob = rev;
        rev = null;
      }

      if (typeof blob === 'string') {
        var binary;
        try {
          binary = utils.atob(blob);
        } catch (err) {
          // it's not base64-encoded, so throw error
          return callback(errors.error(errors.BAD_ARG,
            'Attachments need to be base64 encoded'));
        }
        if (isBrowser) {
          blob = utils.createBlob([utils.binaryStringToArrayBuffer(binary)], {type: type});
        } else {
          blob = binary ? new buffer(binary, 'binary') : '';
        }
      }

      var args = [docId, attachmentId, rev, null, type];
      sendBinaryMessage('putAttachment', args, 3, blob, callback);
    });

  api.put = adapterFun('put', utils.getArguments(function (args) {
    var temp, temptype, opts;
    var doc = args.shift();
    var id = '_id' in doc;
    var callback = args.pop();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(errors.error(errors.NOT_AN_OBJECT));
    }

    doc = utils.clone(doc);

    preprocessAttachments(doc).then(function () {
      while (true) {
        temp = args.shift();
        temptype = typeof temp;
        if (temptype === "string" && !id) {
          doc._id = temp;
          id = true;
        } else if (temptype === "string" && id && !('_rev' in doc)) {
          doc._rev = temp;
        } else if (temptype === "object") {
          opts = utils.clone(temp);
        }
        if (!args.length) {
          break;
        }
      }
      opts = opts || {};

      sendMessage('put', [doc, opts], callback);
    }).catch(callback);

  }));

  api.post = adapterFun('post', function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = utils.clone(opts);

    sendMessage('post', [doc, opts], callback);
  });

  api._bulkDocs = function (req, opts, callback) {
    sendMessage('bulkDocs', [req, opts], callback);
  };

  api._allDocs = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('allDocs', [opts], callback);
  };

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var messageId = uuid();
      api._changesListeners[messageId] = opts.onChange;
      api._callbacks[messageId] = opts.complete;
      api._socket.send('liveChanges' + ':' + messageId + ':' + JSON.stringify([opts]));
      return {
        cancel: function () {
          api._socket.send('cancelChanges' + ':' + messageId + ':' + JSON.stringify([]));
        }
      };
    }

    // just send all the docs anyway because we need to emit change events
    // TODO: be smarter about emitting changes without building up an array
    var returnDocs = 'returnDocs' in opts ? opts.returnDocs : true;
    opts.returnDocs = true;
    sendMessage('changes', [opts], function (err, res) {
      if (err) {
        opts.complete(err);
        return callback(err);
      }
      res.results.forEach(function (change) {
        opts.onChange(change);
      });
      if (!returnDocs) {
        res.results = [];
      }
      opts.complete(null, res);
      callback(null, res);
    });
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    sendMessage('revsDiff', [req, opts], callback);
  });

  api._query = adapterFun('query', function (fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var funEncoded = fun;
    if (typeof fun === 'function') {
      funEncoded = {map: fun};
    }
    sendMessage('query', [funEncoded, opts], callback);
  });

  api._viewCleanup = adapterFun('viewCleanup', function (callback) {
    sendMessage('viewCleanup', [], callback);
  });

  api._close = function (callback) {
    var cacheKey = '$' + opts.originalName;
    if (!instances[cacheKey]) { // already closed/destroyed
      return callback();
    }
    delete instances[cacheKey];
    close(api, callback);
  };

  api.destroy = adapterFun('destroy', function (callback) {
    var cacheKey = '$' + opts.originalName;

    if (!instances[cacheKey]) { // already closed/destroyed
      return callback(null, {ok: true});
    }
    delete instances[cacheKey];
    sendMessage('destroy', [], function (err, res) {
      if (err) {
        api.emit('error', err);
        return callback(err);
      }
      close(api, function (err) {
        if (err) {
          api.emit('error', err);
          return callback(err);
        }
        api.emit('destroyed');
        api.constructor.emit('destroyed', api._name);
        callback(null, res);
      });
    });
  });
}

// Delete the SocketPouch specified by the given name.
SocketPouch.destroy = utils.toPromise(function (name, opts, callback) {
  opts = opts || {};
  if (typeof opts === 'function') {
    callback = opts;
  }
  var cacheKey = '$' + name;
  var instance = instances[cacheKey];
  if (!instance) { // already destroyed/closed
    return callback(null, {ok: true});
  }
  delete instances[cacheKey];
  instance.destroy(callback);
});

// SocketPouch is a valid adapter.
SocketPouch.valid = function () {
  return true;
};

module.exports = SocketPouch;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.adapter('socket', module.exports);
}
