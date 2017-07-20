(function(OCA, OC) {
	'use strict';

	OCA.SpreedMe = OCA.SpreedMe || {};

	function SignalingBase() {
		this.sessionId = '';
		this.currentCallToken = null;
		this.handlers = {};
	}

	SignalingBase.prototype.on = function(ev, handler) {
		if (!this.handlers.hasOwnProperty(ev)) {
			this.handlers[ev] = [handler];
		} else {
			this.handlers[ev].push(handler);
		}
	};

	SignalingBase.prototype.emit = function(/*ev, data*/) {
		// Override in subclasses.
	};

	SignalingBase.prototype._trigger = function(ev, args) {
		var handlers = this.handlers[ev];
		if (!handlers) {
			return;
		}

		handlers = handlers.slice(0);
		for (var i = 0, len = handlers.length; i < len; i++) {
			var handler = handlers[i];
			handler.apply(handler, args);
		}
	};

	SignalingBase.prototype.getSessionid = function() {
		return this.sessionId;
	};

	SignalingBase.prototype.disconnect = function() {
		this.sessionId = '';
		this.currentCallToken = null;
	};

	SignalingBase.prototype.emit = function(ev, data) {
		switch (ev) {
			case 'join':
				var callback = arguments[2];
				var token = data;
				this.joinCall(token, callback);
				break;
			case 'leave':
				this.leaveCurrentCall();
				break;
			case 'message':
				this.sendCallMessage(data);
				break;
		}
	};

	SignalingBase.prototype.leaveCurrentCall = function() {
		if (this.currentCallToken) {
			this.leaveCall(this.currentCallToken);
			this.currentCallToken = null;
		}
	};

	SignalingBase.prototype.leaveAllCalls = function() {
		// Override if necessary.
	};

	SignalingBase.prototype.setRoomCollection = function(rooms) {
		this.roomCollection = rooms;
		return this.syncRooms();
	};

	SignalingBase.prototype.syncRooms = function() {
		var defer = $.Deferred();
		if (this.roomCollection && oc_current_user) {
			this.roomCollection.fetch({
				success: function(data) {
					defer.resolve(data);
				}
			});
		} else {
			defer.resolve([]);
		}
		return defer;
	};

	// Connection to the internal signaling server provided by the app.
	function InternalSignaling() {
		SignalingBase.prototype.constructor.apply(this, arguments);
		this.spreedArrayConnection = [];
		this._openEventSource();

		this.pingFails = 0;
		this.pingInterval = null;

		this.sendInterval = window.setInterval(function(){
			this.sendPendingMessages();
		}.bind(this), 500);
	}

	InternalSignaling.prototype = new SignalingBase();
	InternalSignaling.prototype.constructor = InternalSignaling;

	InternalSignaling.prototype.disconnect = function() {
		this.spreedArrayConnection = [];
		if (this.source) {
			this.source.close();
			this.source = null;
		}
		if (this.sendInterval) {
			window.clearInterval(this.sendInterval);
			this.sendInterval = null;
		}
		if (this.pingInterval) {
			window.clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
		if (this.roomPoller) {
			window.clearInterval(this.roomPoller);
			this.roomPoller = null;
		}
		SignalingBase.prototype.disconnect.apply(this, arguments);
	};

	InternalSignaling.prototype.on = function(ev/*, handler*/) {
		SignalingBase.prototype.on.apply(this, arguments);

		switch (ev) {
			case 'connect':
				// A connection is established if we can perform a request
				// through it.
				this._sendMessageWithCallback(ev);
				break;

			case 'stunservers':
			case 'turnservers':
				// Values are not pushed by the server but have to be explicitly
				// requested.
				this._sendMessageWithCallback(ev);
				break;
		}
	};

	InternalSignaling.prototype._sendMessageWithCallback = function(ev) {
		var message = [{
			ev: ev
		}];
		$.post(OC.generateUrl('/apps/spreed/signalling'), {
			messages: JSON.stringify(message)
		}, function(data) {
			this._trigger(ev, [data]);
		}.bind(this));
	};

	InternalSignaling.prototype.joinCall = function(token, callback) {
		// The client is joining a new call, in this case we need
		// to do the following:
		//
		// 1. Join the call as participant.
		// 2. Get a list of other connected clients in the call.
		// 3. Pass information about the clients that need to be called by you to the callback.
		//
		// The clients will then use the message command to exchange
		// their signalling information.
		$.ajax({
			url: OC.linkToOCS('apps/spreed/api/v1/call', 2) + token,
			type: 'POST',
			beforeSend: function (request) {
				request.setRequestHeader('Accept', 'application/json');
			},
			success: function (result) {
				console.log("Joined", result);
				this.sessionId = result.ocs.data.sessionId;
				this.currentCallToken = token;
				this._startPingCall();
				this._getCallPeers(token).then(function(peers) {
					var callDescription = {
						'clients': {}
					};

					peers.forEach(function(element) {
						if (element['sessionId'] < this.sessionId) {
							callDescription['clients'][element['sessionId']] = {
								'video': true
							};
						}
					}.bind(this));
					callback('', callDescription);
				}.bind(this));
			}.bind(this)
		});
	};

	InternalSignaling.prototype.leaveCall = function(token) {
		if (token === this.currentCallToken) {
			this._stopPingCall();
		}
		$.ajax({
			url: OC.linkToOCS('apps/spreed/api/v1/call', 2) + token,
			method: 'DELETE',
			async: false
		});
	};

	InternalSignaling.prototype.sendCallMessage = function(data) {
		if(data.type === 'answer') {
			console.log("ANSWER", data);
		} else if(data.type === 'offer') {
			console.log("OFFER", data);
		}
		this.spreedArrayConnection.push({
			ev: "message",
			fn: JSON.stringify(data),
			sessionId: this.sessionId
		});
	};

	InternalSignaling.prototype.setRoomCollection = function(/*rooms*/) {
		this._pollForRoomChanges();
		return SignalingBase.prototype.setRoomCollection.apply(this, arguments);
	};

	InternalSignaling.prototype._pollForRoomChanges = function() {
		if (this.roomPoller) {
			window.clearInterval(this.roomPoller);
		}
		this.roomPoller = window.setInterval(function() {
			this.syncRooms();
		}.bind(this), 10000);
	};

	/**
	 * @private
	 */
	InternalSignaling.prototype._getCallPeers = function(token) {
		var defer = $.Deferred();
		$.ajax({
			beforeSend: function (request) {
				request.setRequestHeader('Accept', 'application/json');
			},
			url: OC.linkToOCS('apps/spreed/api/v1/call', 2) + token,
			success: function (result) {
				var peers = result.ocs.data;
				defer.resolve(peers);
			}
		});
		return defer;
	};

	/**
	 * @private
	 */
	InternalSignaling.prototype._openEventSource = function() {
		// Connect to the messages endpoint and pull for new messages
		this.source = new OC.EventSource(OC.generateUrl('/apps/spreed/messages'));

		this.source.listen('usersInRoom', function(users) {
			this._trigger('usersInRoom', [users]);
		}.bind(this));
		this.source.listen('message', function(message) {
			if (typeof(message) === 'string') {
				message = JSON.parse(message);
			}
			this._trigger('message', [message]);
		}.bind(this));
		this.source.listen('__internal__', function(data) {
			if (data === 'close') {
				console.log('signaling connection closed - will reopen');
				setTimeout(function() {
					this._openEventSource();
				}.bind(this), 0);
			}
		}.bind(this));
	};

	/**
	 * @private
	 */
	InternalSignaling.prototype.sendPendingMessages = function() {
		if (!this.spreedArrayConnection.length) {
			return;
		}

		$.post(OC.generateUrl('/apps/spreed/signalling'), {
			messages: JSON.stringify(this.spreedArrayConnection)
		});
		this.spreedArrayConnection = [];
	};

	/**
	 * @private
	 */
	InternalSignaling.prototype._startPingCall = function() {
		this._pingCall();
		// Send a ping to the server all 5 seconds to ensure that the connection
		// is still alive.
		this.pingInterval = window.setInterval(function() {
			this._pingCall();
		}.bind(this), 5000);
	};

	/**
	 * @private
	 */
	InternalSignaling.prototype._stopPingCall = function() {
		if (this.pingInterval) {
			window.clearInterval(this.pingInterval);
			this.pingInterval = null;
		}
	};

	/**
	 * @private
	 */
	InternalSignaling.prototype._pingCall = function() {
		if (!this.currentCallToken) {
			return;
		}

		$.ajax({
			url: OC.linkToOCS('apps/spreed/api/v1/call', 2) + this.currentCallToken + '/ping',
			method: 'POST'
		}).done(function() {
			this.pingFails = 0;
		}.bind(this)).fail(function(xhr) {
			// If there is an error when pinging, retry for 3 times.
			if (xhr.status !== 404 && this.pingFails < 3) {
				this.pingFails++;
				return;
			}
			OCA.SpreedMe.Calls.leaveCurrentCall(false);
		}.bind(this));
	};

	function StandaloneSignaling(url) {
		SignalingBase.prototype.constructor.apply(this, arguments);
		// Make sure we are using websocket urls.
		if (url.indexOf("https://") === 0) {
			url = "wss://" + url.substr(8);
		} else if (url.indexOf("http://") === 0) {
			url = "ws://" + url.substr(7);
		}
		if (url[url.length - 1] === "/") {
			url = url.substr(0, url.length - 1);
		}
		this.url = url + "/spreed";
		this.initialReconnectIntervalMs = 1000;
		this.maxReconnectIntervalMs = 16000;
		this.reconnectIntervalMs = this.initialReconnectIntervalMs;
		this.connect();
	}

	StandaloneSignaling.prototype = new SignalingBase();
	StandaloneSignaling.prototype.constructor = StandaloneSignaling;

	StandaloneSignaling.prototype.reconnect = function() {
		if (this.reconnectTimer) {
			return;
		}

		// Wiggle interval a little bit to prevent all clients from connecting
		// simultaneously in case the server connection is interrupted.
		var interval = this.reconnectIntervalMs - (this.reconnectIntervalMs / 2) + (this.reconnectIntervalMs * Math.random());
		console.log("Reconnect in", interval);
		this.reconnectTimer = window.setTimeout(function() {
			this.reconnectTimer = null;
			this.connect();
		}.bind(this), interval);
		this.reconnectIntervalMs = this.reconnectIntervalMs * 2;
		if (this.reconnectIntervalMs > this.maxReconnectIntervalMs) {
			this.reconnectIntervalMs = this.maxReconnectIntervalMs;
		}
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}
	};

	StandaloneSignaling.prototype.connect = function() {
		console.log("Connecting to", this.url);
		this.callbacks = {};
		this.id = 1;
		this.pendingMessages = [];
		this.connected = false;
		this.socket = new WebSocket(this.url);
		window.signalingSocket = this.socket;
		this.socket.onopen = function(event) {
			console.log("Connected", event);
			this.reconnectIntervalMs = this.initialReconnectIntervalMs;
			this.sendHello();
		}.bind(this);
		this.socket.onerror = function(event) {
			console.log("Error", event);
			this.reconnect();
		}.bind(this);
		this.socket.onclose = function(event) {
			console.log("Close", event);
			this.reconnect();
		}.bind(this);
		this.socket.onmessage = function(event) {
			var data = event.data;
			if (typeof(data) === "string") {
				data = JSON.parse(data);
			}
			console.log("Received", data);
			var id = data.id;
			if (id && this.callbacks.hasOwnProperty(id)) {
				var cb = this.callbacks[id];
					delete this.callbacks[id];
				cb(data);
			}
			switch (data.type) {
				case "hello":
					if (!id) {
						// Only process if not received as result of our "hello".
						this.helloResponseReceived(data);
					}
					break;
				case "room":
					// No special processing required for now.
					break;
				case "event":
					this.processEvent(data);
					break;
				case "message":
					data.message.data.from = data.message.sender.sessionid;
					this._trigger("message", [data.message.data]);
					break;
				default:
					if (!id) {
						console.log("Ignore unknown event", data);
					}
					break;
			}
		}.bind(this);
	};

	StandaloneSignaling.prototype.disconnect = function() {
		if (this.socket) {
			this.doSend({
				"type": "bye",
				"bye": {}
			});
			this.socket.close();
			this.socket = null;
		}
		SignalingBase.prototype.disconnect.apply(this, arguments);
	};

	StandaloneSignaling.prototype.on = function(ev/*, handler*/) {
		SignalingBase.prototype.on.apply(this, arguments);

		switch (ev) {
			case "stunservers":
			case "turnservers":
				// TODO(fancycode): Implement getting STUN/TURN settings.
				break;
		}
	};

	StandaloneSignaling.prototype.sendCallMessage = function(data) {
		this.doSend({
			"type": "message",
			"message": {
				"recipient": {
					"type": "session",
					"sessionid": data.to
				},
				"data": data
			}
		});
	};

	StandaloneSignaling.prototype.doSend = function(msg, callback) {
		if (!this.connected && msg.type !== "hello") {
			// Defer sending any messages until the hello rsponse has been
			// received.
			this.pendingMessages.push([msg, callback]);
			return;
		}

		if (callback) {
			var id = this.id++;
			this.callbacks[id] = callback;
			msg["id"] = ""+id;
		}
		console.log("Sending", msg);
		this.socket.send(JSON.stringify(msg));
	};

	StandaloneSignaling.prototype.sendHello = function() {
		var msg;
		if (this.sessionId) {
			console.log("Trying to resume session", this.sessionId);
			msg = {
				"type": "hello",
				"hello": {
					"version": "1.0",
					"sessionid": this.sessionId
				}
			};
		} else {
			var user = OC.getCurrentUser();
			var url = OC.generateUrl("/apps/spreed/signalling/backend");
			var ticket = $("#app").attr("data-signalingticket");
			msg = {
				"type": "hello",
				"hello": {
					"version": "1.0",
					"auth": {
						"url": OC.getProtocol() + "://" + OC.getHost() + url,
						"params": {
							"userid": user.uid,
							"ticket": ticket,
						}
					}
				}
			};
		}
		this.doSend(msg, this.helloResponseReceived.bind(this));
	};

	StandaloneSignaling.prototype.helloResponseReceived = function(data) {
		console.log("Hello response received", data);
		if (data.type !== "hello") {
			if (this.sessionId) {
				// Resuming the session failed, reconnect as new session.
				this.sessionId = '';
				this.sendHello();
				return;
			}

			// TODO(fancycode): How should this be handled better?
			console.error("Could not connect to server", data);
			this.reconnect();
			return;
		}

		var resumedSession = !!this.sessionId;
		this.connected = true;
		this.sessionId = data.hello.sessionid;

		var messages = this.pendingMessages;
		this.pendingMessages = [];
		for (var i = 0; i < messages.length; i++) {
			var msg = messages[i][0];
			var callback = messages[i][1];
			this.doSend(msg, callback);
		}

		this._trigger("connect");
		if (!resumedSession && this.currentCallToken) {
			this.joinCall(this.currentCallToken);
		}
	};

	StandaloneSignaling.prototype.joinCall = function(token, callback) {
		console.log("Join call", token);
		this.doSend({
			"type": "room",
			"room": {
				"roomid": token
			}
		}, function(data) {
			this.joinResponseReceived(data, token, callback);
		}.bind(this));
	};

	StandaloneSignaling.prototype.joinResponseReceived = function(data, token, callback) {
		console.log("Joined", data, token);
		this.currentCallToken = token;
		if (this.roomCollection) {
			// The list of rooms is not fetched from the server. Update ping
			// of joined room so it gets sorted to the top.
			this.roomCollection.forEach(function(room) {
				if (room.get('token') === token) {
					room.set('lastPing', (new Date()).getTime() / 1000);
				}
			});
			this.roomCollection.sort();
		}
		if (callback) {
			var roomDescription = {
				"clients": {}
			};
			callback('', roomDescription);
		}
	};

	StandaloneSignaling.prototype.leaveCall = function(token) {
		console.log("Leave call", token);
		this.doSend({
			"type": "room",
			"room": {
				"roomid": ""
			}
		}, function(data) {
			console.log("Left", data);
			this.currentCallToken = null;
		}.bind(this));
	};

	StandaloneSignaling.prototype.processEvent = function(data) {
		switch (data.event.target) {
			case "room":
				this.processRoomEvent(data);
				break;
			case "roomlist":
				this.processRoomListEvent(data);
				break;
			default:
				console.log("Unsupported event target", data);
				break;
		}
	};

	StandaloneSignaling.prototype.processRoomEvent = function(data) {
		switch (data.event.type) {
			case "join":
				console.log("Users joined", data.event.join);
				this._trigger("usersJoined", [data.event.join]);
				break;
			case "leave":
				console.log("Users left", data.event.leave);
				this._trigger("usersLeft", [data.event.leave]);
				break;
			default:
				console.log("Unknown room event", data);
				break;
		}
	};

	StandaloneSignaling.prototype.setRoomCollection = function(/* rooms */) {
		SignalingBase.prototype.setRoomCollection.apply(this, arguments);
		// Retrieve initial list of rooms for this user.
		return this.internalSyncRooms();
	};

	StandaloneSignaling.prototype.syncRooms = function() {
		// Never manually sync rooms, will be done based on notifications
		// from the signaling server.
		var defer = $.Deferred();
		defer.resolve([]);
		return defer;
	};

	StandaloneSignaling.prototype.internalSyncRooms = function() {
		return SignalingBase.prototype.syncRooms.apply(this, arguments);
	};

	StandaloneSignaling.prototype.processRoomListEvent = function(data) {
		console.log("Room list event", data);
		this.internalSyncRooms();
	};

	OCA.SpreedMe.createSignalingConnection = function() {
		var url = $("#app").attr("data-signalingserver");
		if (url)  {
			return new StandaloneSignaling(url);
		} else {
			return new InternalSignaling();
		}
	};

})(OCA, OC);
