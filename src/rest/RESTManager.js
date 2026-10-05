'use strict';

const { setInterval } = require('node:timers');
const { Collection } = require('@discordjs/collection');
const makeFetchCookie = require('fetch-cookie');
const { CookieJar } = require('tough-cookie');
const { fetch: fetchOriginal, buildConnector, Client, ProxyAgent } = require('undici');
const APIRequest = require('./APIRequest');
const routeBuilder = require('./APIRouter');
const RequestHandler = require('./RequestHandler');
const { Error: DiscordError } = require('../errors');
const { Endpoints, ciphers } = require('../util/Constants');
const Util = require('../util/Util');

class RESTManager {
  constructor(client) {
    this.client = client;
    this.handlers = new Collection();
    this.dispatchers = new Map();
    this.controllers = new Set();
    this.destroyed = false;
    this.abortController = new AbortController();
    this.versioned = true;
    this.globalLimit = client.options.restGlobalRateLimit > 0 ? client.options.restGlobalRateLimit : Infinity;
    this.globalRemaining = this.globalLimit;
    this.globalReset = null;
    this.globalDelay = null;
    this.cookieJar = new CookieJar();
    this.fetch = makeFetchCookie.default(fetchOriginal, this.cookieJar);
    if (client.options.restSweepInterval > 0) {
      this.sweepInterval = setInterval(() => {
        this.handlers.sweep(handler => handler._inactive);
      }, client.options.restSweepInterval * 1_000).unref();
    }
  }

  get api() {
    return routeBuilder(this);
  }

  getAuth() {
    const token = this.client.token ?? this.client.accessToken;
    if (token) return token?.replace(/Bot /g, '');
    throw new DiscordError('TOKEN_MISSING');
  }

  get cdn() {
    return Endpoints.CDN(this.client.options.http.cdn);
  }

  request(method, url, options = {}) {
    if (this.destroyed) return Promise.reject(new Error('REST manager has been destroyed'));
    const apiRequest = new APIRequest(this, method, url, options);
    let handler = this.handlers.get(apiRequest.route);

    if (!handler) {
      handler = new RequestHandler(this);
      this.handlers.set(apiRequest.route, handler);
    }

    return handler.push(apiRequest);
  }

  get endpoint() {
    return this.client.options.http.api;
  }

  set endpoint(endpoint) {
    this.client.options.http.api = endpoint;
  }

  getDispatcher(url) {
    if (this.destroyed) throw new Error('REST manager has been destroyed');
    const origin = new URL(url).origin;
    let dispatcher = this.dispatchers.get(origin);
    if (!dispatcher) {
      const proxy = Util.checkUndiciProxyAgent(this.client.options.http.agent);
      dispatcher = proxy
        ? new ProxyAgent({ ...proxy, ciphers: ciphers.join(':') })
        : new Client(origin, { connect: buildConnector({ ciphers: ciphers.join(':') }) });
      this.dispatchers.set(origin, dispatcher);
    }
    return dispatcher;
  }

  destroy() {
    this.destroyed = true;
    this.abortController.abort();
    clearInterval(this.sweepInterval);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const dispatcher of this.dispatchers.values()) dispatcher.destroy().catch(() => {});
    this.dispatchers.clear();
  }
}

module.exports = RESTManager;
