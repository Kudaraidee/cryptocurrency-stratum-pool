var https = require('https');
var BigNum = require('bignum');
var net = require('net');
var events = require('events');
var tls = require('tls');
var fs = require('fs');

var util = require('./util.js');

var varDiff = require('./varDiff.js');

var TLSoptions;

var isValidHexRegex = /^[0-9A-Fa-f]+$/;


var SubscriptionCounter = function(poolId) {
    var count = 0;
    var padding = 'deadbeefcafebabe'.substring(0, 16 - poolId.length) + poolId;
    return {
        next: function(){
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};

/**
 * Defining each client that connects to the stratum server. 
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
**/
var StratumClient = function(options){
    var pendingDifficulty = null;
    //private members
    this.socket = options.socket;

    this.remoteAddress = options.socket.remoteAddress;

    var banning = options.banning;

    var _this = this;

    this.supportsExtranonceSubscribe = false;
    this.initialDifficulty = -1;
    this.minimumDifficulty = -1;

    this.isSoloMining = false;

    this.lastActivity = Date.now();

    this.shares = {valid: 0, invalid: 0};

    var considerBan = (!banning || !banning.enabled) ? function(){ return false } : function(shareValid){
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold){
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                this.shares = {valid: 0, invalid: 0};
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    this.init = function init(){
        setupSocket();
    };

    function handleMessage(message){
        switch(message.method){
            case 'mining.extranonce.subscribe':
                handleExtraNonceSubscribe(message);
                break;
            case 'mining.subscribe':
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                handleAuthorize(message, true);
                break;
            case 'mining.configure':
                handleConfigure(message);
                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                sendJson({
                    id     : null,
                    result : [],
                    error  : true
                });
                break;
            case 'mining.suggest_target':
                handleSuggestTarget(message);
                break;
            case 'mining.suggest_difficulty':
                handleSuggestDifficulty(message);
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleExtraNonceSubscribe(message) {
        _this.supportsExtranonceSubscribe = true;
        sendJson({
            id: message.id,
            result: true,
            "error": null
        });
    }

    function handleSubscribe(message){
        if (! _this._authorized ) {
            _this.requestedSubscriptionBeforeAuth = true;
        }
        _this.emit('subscription',
            {},
            function(error, extraNonce1, extraNonce2Size){
                if (error){
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;
                sendJson({
                    id: message.id,
                    result: [
                        [
                            ["mining.set_difficulty", options.subscriptionId],
                            ["mining.notify", options.subscriptionId]
                        ],
                        extraNonce1,
                        extraNonce2Size
                    ],
                    error: null
                });
            }
        );
    }

    function handleAuthorize(message, replyToSocket){
        _this.workerName = message.params[0];
        _this.workerPass = message.params[1];
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, function(result) {
            _this.authorized = (!result.error && result.authorized);
            
            if (replyToSocket) {
                sendJson({
                    id     : message.id,
                    result : _this.authorized,
                    error  : result.error
                });
            }

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            } else {
                var passwordArgs = _this.workerPass.split(',');
                for (var i = 0; i < passwordArgs.length; i++) {
                    var key = passwordArgs[i].substr(0, passwordArgs[i].indexOf('='));
                    switch (key.toLowerCase()) {
                        case 'd':
                            _this.initialDifficulty = parseInt(passwordArgs[i].substr(passwordArgs[i].indexOf('=') + 1)) || -1;
                            break;
                        case 'md':
                            if (!_this.varDiff) {
                                _this.minimumDifficulty = parseInt(passwordArgs[i].substr(passwordArgs[i].indexOf('=') + 1)) || -1;
                                if (options.defaultVarDiff && _this.minimumDifficulty > -1) {
                                    _this.varDiff = new varDiff(options.socket.localPort, Object.assign({}, options.defaultVarDiff, {
                                        minDiff: _this.minimumDifficulty,
                                        maxDiff: 2 * _this.minimumDifficulty
                                    }));

                                    _this.varDiff.manageClient(_this);
                                }
                            }
                            break;
                        case 'm':
                            _this.isSoloMining = passwordArgs[i].substr(passwordArgs[i].indexOf('=') + 1).trim().toLowerCase() === 'solo'
                            break;
                        default:
                            break;
                    }
                }

                if (_this.requestedSubscriptionBeforeAuth) {
                    if (_this.initialDifficulty > 0) {
                        _this.sendDifficulty(_this.initialDifficulty);
                    }
                }
            }
        });
    }

    function handleSubmit(message){
        if (!_this.workerName){
            _this.workerName = message.params[0];
        }

        if (!_this.authorized){
            sendJson({
                id    : message.id,
                result: null,
                error : [24, "unauthorized worker", null]
            });
            considerBan(false);
            return;
        }
        if (!_this.extraNonce1){
            sendJson({
                id    : message.id,
                result: null,
                error : [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }
        var params = {
            name        : _this.workerName,
            jobId       : message.params[1]
        };
        if (!options.coin.isZCashProtocol) {
            params.extraNonce2 = message.params[2];
            params.nTime = message.params[3].toLowerCase();
            params.nonce = message.params[4].toLowerCase();
        } else {
            params.nTime = message.params[2];
            params.extraNonce2 = message.params[3];
            params.soln = message.params[4];
            params.nonce = _this.extraNonce1 + message.params[3];
        }

        if (options.coin.version_mask && isValidHexRegex.test(options.coin.version_mask) && message.params.length > 5 && isValidHexRegex.test(message.params[5])) {
            var versionMask = parseInt(message.params[5], 16);
            if (versionMask && ((~parseInt(options.coin.version_mask, 16)) & versionMask) !== 0) {
                sendJson({
                    id    : message.id,
                    result: null,
                    error : [6, "invalid version mask", null]
                });
                considerBan(false);
                return;
            }
            params.versionMask = versionMask;
        }

        _this.emit('submit', params,
            function(error, result){
                if (!considerBan(result)){
                    sendJson({
                        id: message.id,
                        result: !options.coin.isZCashProtocol ? result : error ? false : true,
                        error: error
                    });
                }
            }
        );
    }

    function handleSuggestTarget(message) {
        var zeroPad = 0;

        for(var i = 0; i < message.params[0].length; i++) {
            if (i === '0') {
                zeroPad++;
            } else {
                break;
            }
        }

        var adj = parseInt('0x' + message.params[0].slice(zeroPad, 64));
        if (adj) {
            _this.difficulty /= adj;
        }

        sendJson({
            id: message.id,
            result: true,
            "error": null
        });
    }

    function handleSuggestDifficulty(message) {
        _this.difficulty = message.params[0];

        sendJson({
            id: message.id,
            result: true,
            "error": null
        });
    }

    function handleConfigure(message) {
        if (options.coin.version_mask && isValidHexRegex.test(options.coin.version_mask)) {
            sendJson({
                id: message.id,
                result: {
                    'version-rolling': true,
                    'version-rolling.mask': options.coin.version_mask
                },
                error: null
            });
        } else {
            _this.emit('unknownStratumMethod', message);
        }
    }

    function sendJson(){
        var response = '';
        for (var i = 0; i < arguments.length; i++){
            response += JSON.stringify(arguments[i]) + '\n';
        }
        options.socket.write(response);
    }

    function setupSocket(){
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                }
                else{
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        }
        else{
            _this.emit('checkBan');
        }
        socket.on('data', function(d){
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1){
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function(message){
                    if (message === '') return;
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch(e) {
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0){
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }
                        return;
                    }

                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function() {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function(err){
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }


    this.getLabel = function(){
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
    };

    this.enqueueNextDifficulty = function(requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function(difficulty){
        if (difficulty === this.difficulty)
            return false;

        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;

        if (!options.coin.isZCashProtocol) {
            sendJson({
                id    : null,
                method: "mining.set_difficulty",
                params: [difficulty],
            });
        } else {
            var powLimit = algos.equihash.diff; // TODO: Get algos object from argument
            var adjPow = powLimit / difficulty;
            var hexAdjPow = adjPow.toString(16);
            var numZeros = 64 - hexAdjPow.length;
            var zeroPad = numZeros === 0 ? '' : '0'.repeat(numZeros);

            sendJson({
                id    : null,
                method: "mining.set_target",
                params: [(zeroPad + hexAdjPow).substr(0, 64)]
            });
        }
        return true;
    };

    this.sendMiningJob = function(jobParams, odoKey){

        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000){
            _this.emit('socketTimeout', 'last submitted a share was ' + (lastActivityAgo / 1000 | 0) + ' seconds ago');
            _this.socket.destroy();
            return;
        }

        if (pendingDifficulty !== null){
            var result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }
        var json = {
            id    : null,
            method: "mining.notify",
            params: jobParams
        };

        if (odoKey !== null) {
            json.odokey = odoKey;
        }

        sendJson(json);
    };

    this.manuallyAuthClient = function (username, password) {
        handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    };

    this.manuallySetValues = function (otherClient) {
        _this.extraNonce1        = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty         = otherClient.difficulty;
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn){

    //private members

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, haproxy, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null;

    var _this = this;
    var stratumClients = {};
    var subscriptionCounter = SubscriptionCounter(options.poolId || '');
    var rebroadcastTimeout;
    var bannedIPs = {};

    function checkBan(client){
        if (options.banning && options.banning.enabled) {
            if (options.banning.banned && options.banning.banned.includes(client.remoteAddress)) {
                client.socket.destroy();
                client.emit('kickedBannedIP', 9999999);
                return;
            }

            if (client.remoteAddress in bannedIPs) {
                var bannedTime = bannedIPs[client.remoteAddress];
                var bannedTimeAgo = Date.now() - bannedTime;
                var timeLeft = bannedMS - bannedTimeAgo;
                if (timeLeft > 0){
                    client.socket.destroy();
                    client.emit('kickedBannedIP', timeLeft / 1000 | 0);
                } else {
                    delete bannedIPs[client.remoteAddress];
                    client.emit('forgaveBannedIP');
                }
            }
        }
    }

    this.handleNewClient = function (socket){

        socket.setKeepAlive(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: authorizeFn,
                socket: socket,
                banning: options.banning,
                connectionTimeout: options.connectionTimeout,
                tcpProxyProtocol: options.tcpProxyProtocol,
                coin: options.coin,
                dynamicVarDiff: options.dynamicVarDiff
            }
        );

        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function() {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function(){
            checkBan(client);
        }).on('triggerBan', function(){
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function(jobParams, odoKey){
        for (var clientId in stratumClients) {
            var client = stratumClients[clientId];
            client.sendMiningJob(jobParams, odoKey);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function(){
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };



    (function init(){

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (options.banning && options.banning.enabled){
            setInterval(function(){
                for (ip in bannedIPs){
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval);
        }


        //SetupBroadcasting();
        if ((typeof(options.tlsOptions) !== 'undefined' && typeof(options.tlsOptions.enabled) !== 'undefined') && (options.tlsOptions.enabled === "true" || options.tlsOptions.enabled === true)) {
            TLSoptions = {
                key: fs.readFileSync(options.tlsOptions.serverKey),
                cert: fs.readFileSync(options.tlsOptions.serverCert),
                requireCert: true
            };
        }

        var serversStarted = 0;
        Object.keys(options.ports).forEach(function(port){
            if (typeof options.ports[port].tls === 'undefined' || options.ports[port].tls === false || options.ports[port].tls === "false") {
                net.createServer({allowHalfOpen: false}, function(socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function() {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            } else {
                tls.createServer(TLSoptions, function(socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function() {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            }
        });
    })();


    //public members

    this.addBannedIP = function(ipAddress){
        bannedIPs[ipAddress] = Date.now();
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.manuallyAddStratumClient = function(clientObj) {
        var subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
