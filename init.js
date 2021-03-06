'use strict';

var async = require('async'),
    _ = require('lodash'),
    logger = require('./lib/logger');

async.auto({
  environment:     environment,
  validators:      validators,
  database:        [ 'environment', database ],
  certificate:     [ 'environment', certificate ],
  middleware:      middleware,
  httpd:           [ 'environment', httpd ],
  models:          [ 'database', models ],
  auth:            [ 'models', 'httpd', auth ],
  routes:          [ 'auth', 'validators', 'models', 'httpd', routes ]
}, complete);

function environment(callback) {
  if (!process.env.SECRET) {
    logger.warn('No $SECRET present. Generating a temporary random value.');
    process.env.SECRET = require('crypto').randomBytes(256);
  }
  if (!process.env.PORT) {
    logger.warn('No $PORT present. Choosing a sane default, 8081.');
    process.env.PORT = 8081;
  }
    if (!process.env.MONGO_URI) {
    logger.warn('No $MONGO_URI present. Defaulting to `mongodb://localhost/vis`.');
    process.env.MONGO_URI = 'mongodb://localhost/vis';
  }
  // OAuth Stuff
  if (!process.env.REQUEST_TOKEN_URL) {
    logger.warn('No $REQUEST_TOKEN_URL present. Defaulting to `https://localhost:8080/oauth/request_token`.');
    process.env.REQUEST_TOKEN_URL = 'https://localhost:8080/oauth/request_token';
  }
  if (!process.env.ACCESS_TOKEN_URL) {
    logger.warn('No $ACCESS_TOKEN_URL present. Defaulting to `https://localhost:8080/oauth/access_token`.');
    process.env.ACCESS_TOKEN_URL = 'https://localhost:8080/oauth/access_token';
  }
  if (!process.env.USER_AUTHORIZATION_URL) {
    logger.warn('No $USER_AUTHORIZATION_URL present. Defaulting to `https://localhost:8080/oauth/authorize`.');
    process.env.USER_AUTHORIZATION_URL = 'https://localhost:8080/oauth/authorize';
  }
  if (!process.env.CALLBACK_URL) {
    logger.warn('No $CALLBACK_URL present. Defaulting to `https://localhost:8080/auth/callback`.');
    process.env.CALLBACK_URL = 'https://localhost:8080/auth/callback';
  }
  if (!process.env.CONSUMER_KEY) {
    logger.warn('No $CONSUMER_KEY present. Defaulting to `test`.');
    process.env.CONSUMER_KEY = 'test';
  }
  if (!process.env.CONSUMER_SECRET) {
    logger.warn('No $CONSUMER_SECRET present. Defaulting to `test`.');
    process.env.CONSUMER_SECRET = 'test';
  }
  return callback(null);
}

/**
 * Setup the SSL Certificates.
 * @param {Function} next - The callback.
 */
function certificate(next) {
  var fs = require('fs');
  // Get the certificates.
  async.auto({
    key:  function (next) { fs.readFile('cert/server.key', 'utf8', next); },
    cert: function (next) { fs.readFile('cert/server.crt', 'utf8', next); }
  }, function (error, results) {
    if (error) { generateCertificate(error, results, next); }
    else { return next(error, results); }
  });

  /**
   * Detects if certs are missing and generates one if needed
   * @param {Error|null}  error   - If `error` is non-null, generate a certificate, since one doesn't exist.
   * @param {Object|null} results - Passed to `next`.
   * @param {Function}    next    - The callback. Is passed `error` (if not a certificate error) and `results`.
   */
  function generateCertificate(error, results, next) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Tell Node it's okay.
    if (error && error.code === 'ENOENT') {
      logger.warn('No certificates present in `cert/{server.key, server.crt}`. Generating a temporary certificate.');
      require('pem').createCertificate({ days: 1, selfSigned: true }, function formatKey(error, keys) {
        if (error) { return next(error, null); }
        return next(null, {key: keys.serviceKey, cert: keys.certificate });
      });
    } else {
      return next(error, results);
    }
  }
}

function middleware(callback, data) {
  function providerRequest(req, path, callback) {
    var oauth = {
      consumer_key: process.env.CONSUMER_KEY,
      consumer_secret: process.env.CONSUMER_SECRET,
      token: req.session.passport.user.key,
      token_secret: req.session.passport.user.secret
    };
    require('request').get({ url: process.env.PROVIDER_URL + path, oauth: oauth, json: true }, function (error, request, body) {
      callback(error, request);
    });
    // Callback should be (error, request)
  }
  function populateVisualizationList(req, res, next) {
    if (!req.session.passport.user) { return next(); }
    // TODO: Cache this per user.
    providerRequest(req, '/api', function validation(error, request) {
      if (error) { return next(error); }
      var validated = data.validators.list(request.body);
      if (validated.valid === true) {
        req.visualizations = request.body.visualizations;
        next();
      } else {
        next(new Error(JSON.stringify(validated, 2)));
      }
    });
  }
  function populateVisualization(req, res, next) {
    if (!req.session.passport.user) { return next(); }
    if (!req.params.title) { return res.redirect('/'); }
    providerRequest(req, '/api/' + req.params.title, function validation(error, request) {
      if (error) { return next(error); }
      var validated = data.validators.item(request.body);
      if (validated.valid === true) {
        req.visualization = request.body;
        next();
      } else {
        next(new Error(JSON.stringify(validated, 2)));
      }
    });
  }
  return callback(null, {
    populateVisualizationList: populateVisualizationList,
    populateVisualization: populateVisualization,
    providerRequest: providerRequest
  });
}

function httpd(callback, data) {
  var server = require('express')(),
      passport = require('passport');
  // Set the server engine.
  server.set('view engine', 'hbs');
  // Page Routes
  require('hbs').registerPartials(__dirname + '/views/partials');
  require('hbs').registerHelper('json', function(data) {
    return JSON.stringify(data);
  });
  // Middleware (https://github.com/senchalabs/connect#middleware)
  // Ordering ~matters~.
  // Logger
  server.use(require('morgan')('dev'));
  // Parses Cookies
  server.use(require('cookie-parser')(process.env.SECRET));
  // Parses bodies.
  server.use(require('body-parser').urlencoded({ extended: true }));
  server.use(require('body-parser').json());
  // Static serving of the site from `site`
  server.use('/assets', require('serve-static')('assets'));
  // Session store
  server.use(require('express-session')({
    secret: process.env.SECRET,
    cookie: { secure: true }
  }));
  // Passport middleware.
  server.use(passport.initialize());
  server.use(passport.session());
  // Protects against CSRF.
  // server.use(require('csurf')());
  // Compresses responses.
  server.use(require('compression')());
  return callback(null, server);
}

function database(callback, data) {
  var connection = require('mongoose').connect(process.env.MONGO_URI).connection;
  connection.on('open', function () {
    logger.log('Connected to database on ' + process.env.MONGO_URI);
    return callback(null);
  });
  connection.on('error', function (error) {
    return callback(error, connection);
  });
}

function models(callback, data) {
  return callback(null);
}

function auth(callback, data) {
  var passport = require('passport'),
      OAuth1Strategy = require('passport-oauth1');
  passport.use('oauth', new OAuth1Strategy({
      requestTokenURL: process.env.REQUEST_TOKEN_URL,
      accessTokenURL: process.env.ACCESS_TOKEN_URL,
      userAuthorizationURL: process.env.USER_AUTHORIZATION_URL,
      consumerKey: process.env.CONSUMER_KEY,
      consumerSecret: process.env.CONSUMER_SECRET,
      callbackURL: process.env.CALLBACK_URL
    },
    function verify(token, tokenSecret, profile, done) {
      // TODO: Actually verify.
      console.log('TODO: Verify called.');
      done(null, { key: token, secret: tokenSecret });
    }
  ));
  passport.serializeUser(function(token, done) {
    console.log('Serialize');
    return done(null, token);
  });
  passport.deserializeUser(function(id, done) {
    // TODO
    console.log('Deserialize');
    return done(null, id);
  });
  return callback(null);
}

function validators(callback, data) {
  var tv4 = require('tv4'),
      fs = require('fs');
  /**
   * Creates validator functions for input.
   * @param {String}   file     - The file path.
   * @param {Function} callback - The callback.
   */
  function validatorFactory(file, callback) {
    fs.readFile('./schema/list.json', 'utf8', function (err, file) {
      if (err) { callback(err, null); }
      /**
       * Validates the data based on the schema.
       * @param  {Object} data - The data to validate.
       * @return {Boolean}     - If it's valid.
       */
      function validate(data) {
        return tv4.validateResult(data, JSON.parse(file));
      }
      return callback(null, validate);
    });
  }
  async.parallel({
    item: _.partial(validatorFactory, './schema/item.json'),
    list: _.partial(validatorFactory, './schema/list.json')
  }, function finish(error, results) {
      callback(error, results);
  });
}

function routes(callback, data) {
  var router = new require('express').Router(),
      ensureLoggedIn = require('connect-ensure-login').ensureLoggedIn,
      ensureLoggedOut = require('connect-ensure-login').ensureLoggedOut,
      passport = require('passport');
  router.get('/auth',
    passport.authenticate('oauth')
  );
  router.get('/auth/callback',
    passport.authenticate('oauth', { successReturnToOrRedirect: '/', failureRedirect: '/fail' })
  );
  router.get('/logout', function (req, res) {
    req.logout();
    res.redirect('/');
  });
  router.get('/',
    data.middleware.populateVisualizationList,
    function render(req, res) {
      res.render('index', {
        title: 'Welcome',
        user: req.session.passport.user,
        visualizations: req.visualizations
      });
    }
  );
  router.get('/visualization/:title',
    ensureLoggedIn('/auth'),
    data.middleware.populateVisualization,
    data.middleware.populateVisualizationList,
    function render(req, res) {
      res.render('visualization', {
        title: req.params.title,
        user: req.session.passport.user,
        visualizations: req.visualizations,
        visualization: req.visualization
      });
    }
  );
  // Attach the router.
  data.httpd.use(router);
  callback(null, router);
}

function complete(error, data) {
  if (error) { logger.error(error); throw error; }
  // No errors
  require('https').createServer(data.certificate, data.httpd).listen(process.env.PORT, function () {
    logger.success('Server listening on port ' + process.env.PORT);
  });
}
