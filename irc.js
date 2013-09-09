/* IRC.js - BSD License - Andrea Marchesini <baku@ippolita.net>
 * https://github.com/bakulf/irc.js */

const STATE_DISCONNECTED = 0;
const STATE_CONNECTING   = 1;
const STATE_CONNECTED    = 2;

if (typeof(String.prototype.trim) === "undefined") {
  String.prototype.trim = function() {
    return String(this).replace(/^\s+|\s+$/g, '');
  }
}

function debug(foobar) {
  console.log(foobar);
}

function IRC(aServer, aPort, aSSL, aParams) {
  this._init(aServer, aPort, aSSL, aParams);
}

IRC.prototype = {
  _params: {},
  _nick: null,

  _state: STATE_DISCONNECTED,

  _socket: null,
  _buffer: [],

  // events
  onconnect: null,
  onnickchange: null,
  onjoin: null,
  onpart: null,
  ontopic: null,
  onmode: null,
  onkick: null,
  onnotice: null,
  oninvite: null,
  onprivmsg: null,
  onchannelmsg: null,
  _onerror: null,
  onrawdata: null,

  get onerror() {
    return this._onerror;
  },

  set onerror(f) {
    this._onerror = f;
    if (this._socket) {
      this._socket.onerror = f;
    }
  },

  _init: function(aServer, aPort, aSSL, aParams) {
    this._params = aParams || {};

    this._socket = navigator.mozTCPSocket.open(aServer, aPort, { useSSL: aSSL });

    var self = this;
    this._socket.ondata = function(evt) { self._ondata(evt); }
    this._socket.ondrain = function(evt) { self._ondrain(evt); }
    this._socket.onclose = function(evt) { self._disconnected(); }
    this._socket.onerror = this._onerror;
    // FIXME: other events
  },

  _ondata: function(evt) {
    if (this._state == STATE_DISCONNECTED) {
      this._state = STATE_CONNECTING;
      this._initConnection();
    }

    var lines = evt.data.split('\n');
    for (var i = 0; i < lines.length; ++i) {
      this._parseData(lines[i].trim());
    }
  },

  _disconnected: function() {
    this._state = STATE_DISCONNECTED;
  },

  _parseData: function(aData) {
    debug('Receiving: ' + aData);

    /*
     * From RFC 1459:
     * <message> ::= [':' <prefix> <SPACE> ] <command> <params> <crlf>
     * <prefix> ::= <servername> | <nick> [ '!' <user> ] [ '@' <host> ]
     * <command> ::= <letter> { <letter> } | <number> <number> <number>
     * <SPACE> ::= ' ' { ' ' }
     * <params> ::= <SPACE> [ ':' <trailing> | <middle> <params> ]
     * <middle> ::= <Any *non-empty* sequence of octets not including SPACE
     * or NUL or CR or LF, the first of which may not be ':'>
     * <trailing> ::= <Any, possibly *empty*, sequence of octets not including
     * NUL or CR or LF>
     */

    if (!aData.length) {
      return;
    }

    var prefix;
    var command;
    var params = [];

    // Prefix
    if (aData[0] == ':') {
      var pos = aData.indexOf(' ');
      if (pos == -1) {
        return;
      }

      prefix = aData.substr(1,  pos - 1);
      aData = aData.substr(pos + 1);
    }

    // Command
    var pos = aData.indexOf(' ');
    if (pos == -1) {
      return;
    }
    
    command = aData.substr(0, pos);
    aData = aData.substr(pos + 1);

    // Params
    while (aData.length) {
      if (aData[0] == ':') {
        params.push(aData.substr(1));
        break;
      }

      var pos = aData.indexOf(' ');
      if (pos == -1) {
        params.push(aData);
        break;
      }

      params.push(aData.substr(0, pos));
      aData = aData.substr(pos + 1);
    }

    if (this.onrawdata) {
      this.onrawdata(prefix, command, params);
    }

    switch (command) {
      case '376':
      case '422':
        if (this._state == STATE_CONNECTING) {
          this._state = STATE_CONNECTED;
          if (this.onconnect) {
            this.onconnect();
          }
        }

        break;

      case 'PING':
        this._send('PONG ' + params[0]);
        break;

      case 'NICK':
        var nick = this._getNick(prefix);
        if (nick == this._nick) {
          this._nick = params[0];
        }

        if (this.onnickchange) {
          this.onnickchange(nick, params[0]);
        }
        break;

      case 'QUIT':
        // FIXME: something?
        break;

      case 'JOIN':
        if (this.onjoin) {
          this.onjoin(this._getNick(prefix), params[0]);
        }
        break;

      case 'PART':
        if (this.onpart) {
          this.onpart(this._getNick(prefix), params[0], params[1]);
        }
        break;

      case 'MODE':
        if (this.onmode) {
          this.onmode(this._getNick(prefix), params[0], params[1]);
        }
        break;

      // TODO: case 332:
      case 'TOPIC':
        if (this.ontopic) {
          this.ontopic(this._getNick(prefix), params[0], params[1]);
        }
        break;

      case 'KICK':
        if (this.onkick) {
          this.onkick(this._getNick(prefix), params[1], params[0], params[2]);
        }
        break;

      case 'PRIVMSG':
        var nick = this._getNick(prefix);
        if (this._nick == params[0]) {
          if (this.onprivmsg) {
            this.onprivmsg(nick, params[1]);
          }
        } else { 
          if (this.onchannelmsg) {
            this.onchannelmsg(nick, params[0], params[1]);
          }
        }
        break;

      case 'NOTICE':
        if (this.onnotice) {
          this.onnotice(this._getNick(prefix), params[0], params[1]);
        }
        break;

      case 'INVITE':
        if (this.oninvite) {
          this.oninvite(this._getNick(prefix), params[0], params[1]);
        }
        break;
    }
  },

  _ondrain: function() {
    while (this._buffer.length) {
      var data = this._buffer.shift();
      if (!this._socket.send(data)) {
        this._buffer.unshift(data);
        break;
      }
    }
  },

  _send: function(aData) {
    debug('Sending: ' + aData);

    var data = aData + '\n';

    // draining..
    if (this._buffer.length || !this._socket.send(data)) {
      this._buffer.push(data);
      return;
    }
  },

  _initConnection: function() {
    if (this._params.server_password) {
      this._send('PASS ' + this._params.server_password);
    }

    this._nick = this._params.nick || this._createNick();
    this._send('NICK ' + this._nick);
    this._send('USER ' + (this._params.username || 'nobody') +
                         ' unknown unknown :' +
                         (this._params.realname || 'noname'));
  },

  _createNick: function() {
    return 'JSIRC' + Math.floor(Math.random()*1000);
  },

  _getNick: function(aPrefix) {
    var nick = aPrefix;
    var pos = aPrefix.indexOf('!');
    if (pos != -1) {
      nick = nick.substr(0, pos);
    }
    return nick;
  },

  _throwIfDisconnected: function() {
    if (this._state != STATE_CONNECTED) {
      throw 'IRCJS is not connected';
    }
  },

  _throwIfEmpty: function(what) {
    if (!(what+'').length) {
      throw 'Param is needed';
    }
  },

  join: function(aChannel, aKey) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aChannel);

    if (aKey) {
      this._send('JOIN ' + aChannel + ' :' + aKey);
    } else {
      this._send('JOIN ' + aChannel);
    }
  },

  part: function(aChannel, aReason) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aChannel);

    if (aReason) {
      this._send('PART ' + aChannel + ' :' + aReason);
    } else {
      this._send('PART ' + aChannel);
    }
  },

  topic: function(aChannel, aTopic) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aChannel);

    if (aTopic) {
      this._send('TOPIC ' + aChannel + ' :' + aTopic);
    } else {
      this._send('TOPIC ' + aChannel);
    }
  },

  names: function(aChannel) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aChannel);

    this._send('NAMES ' + aChannel);
  },

  list: function(aChannel) {
    this._throwIfDisconnected();

    if (aChannel) {
      this._send('LIST ' + aChannel);
    } else {
      this._send('LIST');
    }
  },

  invite: function(aNick, aChannel) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNick);
    this._throwIfEmpty(aChannel);

    this._send('INVITE ' + aNick + ' ' + aChannel);
  },

  kick: function(aNick, aChannel, aReason) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNick);
    this._throwIfEmpty(aChannel);

    if (aReason) {
      this._send('KICK ' + aChannel + ' ' + aNick + ' :' + aReason)
    } else {
      this._send('KICK ' + aChannel + ' ' + aNick)
    }
  },

  msg: function(aNickChannel, aText) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNickChannel);

    this._send('PRIVMSG ' + aNickChannel + ' :' + aText);
  },

  notice: function(aNickChannel, aText) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNickChannel);

    this._send('NOTICE ' + aNickChannel + ' :' + aText);
  },

  mode: function(aNickChannel, aMode) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNickChannel);

    if (aMode) {
      this._send('MODE ' + aNickChannel + ' ' + aMode);
    } else {
      this._send('MODE ' + aNickChannel);
    }
  },

  nick: function(aNick) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNick);

    this._send('NICK ' + aNick);
  },

  whois: function(aNick) {
    this._throwIfDisconnected();
    this._throwIfEmpty(aNick);

    this._send('WHOIS ' + aNick);
  },

  quit: function(aReason) {
    this._throwIfDisconnected();
    this._send('QUIT ' + (aReason ? aReason : 'quit'));
  }
};
