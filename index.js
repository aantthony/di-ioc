'use strict';

var $private = require('private-accessor').create();
var annotate = require('fn-annotate');
// Find native promise constructor if available:
var P = typeof Promise === 'undefined' ? require('es6-promise').Promise : Promise;

function applyNew(ctor, args) {
  var instance = Object.create(ctor.prototype || {});
  return ctor.apply(instance, args) || instance;
}

Router.create = module.exports = Router;

var TYPE_SINGLETON = 'singleton';
var TYPE_TRANSIENT = 'transient';
var TYPE_INTERFACE = 'interface';
var TYPE_SUBROUTER = 'use';

function Router(module) {
  var requireFn;
  if (module && module.require) {
    requireFn = module.require.bind(module);
  } else if (typeof module === 'function') {
    // legacy:
    requireFn = module;
  }
  if (!(this instanceof Router)) return new Router(module);
  $private(this).require = requireFn || null;
  $private(this).defs = [];
}

function set(router, type, path, factory) {
  if (type !== TYPE_INTERFACE) factory = factory || $private(router).require(path);
  if (factory instanceof Router) type = TYPE_SUBROUTER;
  var deps = typeof factory === 'function' && annotate(factory) || [];
  var name = path.replace('./', '').replace(/\.js$/, '').replace(/-(.)/g, function (s, first) {
    return first.toUpperCase();
  });

  $private(router).defs.push({name: name, type: type, factory: factory, deps: deps});
}

[TYPE_SINGLETON, TYPE_TRANSIENT, TYPE_INTERFACE, TYPE_SUBROUTER]
.forEach(function (type) {
  Router.prototype[type] = function (path, fn) {
    set(this, type, path, fn);
    return this;
  };
});

function Interface(def, longName) {
  this.validate = def.factory;
  this.longName = longName;
}

function ensureCanLoad(def, scope, siblings, prefix, path) {
  path = path || [];
  if (~path.indexOf(def.name)) {
    var serviceNames = [prefix.join('.')].concat(path.slice(1)).concat([def.name, '...']);
    throw new Error('Circular dependency: ' + serviceNames.join(' -> '));
  }

  return def.deps.every(function (name) {
    if (scope[name]) return true;
    var sibling;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].name === name) {
        sibling = siblings[i];
        break;
      }
    }
    if (sibling) return ensureCanLoad(sibling, scope, siblings, prefix, path.concat([def.name]));
    throw new Error('Unknown dependency: ' + name + ' required by ' + prefix.join('.') + ' ' + path.join('.'));
  });
}

Router.prototype.build = function (getters, prefix) {
  var container = {};
  var defs = $private(this).defs;
  defs.forEach(function (def) {
    var longName = prefix.concat([def.name]);
    if (def.type === TYPE_SUBROUTER) return container[def.name] = def.factory.build(getters, longName);
    if (def.type === TYPE_INTERFACE) return   getters[def.name] = new Interface(def, longName);

    ensureCanLoad(def, getters, defs, longName);

    var existing = getters[def.name];
    if (existing && !(existing instanceof Interface)) {
      throw new Error('Re-definition of service ' + existing.longName.join('.') + ': ' + longName.join('.'));
    }

    var validate = existing && existing.validate;

    var sharedInstance;
    var get = getters[def.name] = function (locals) {
      if (sharedInstance) return sharedInstance;

      var args = def.deps.map(function (name) {
        if (locals) {
          var local = locals[name];
          if (local) return local;
        }
        var getter = getters[name];
        if (getter instanceof Interface) {
          throw new Error('Interface ' + getter.longName.join('.') + ' has no implementation, but is required by ' + longName.join('.'));
        }
        return getter(locals);
      });

      var newInstance = applyNew(def.factory, args);

      if (def.type === TYPE_SINGLETON) {
        sharedInstance = newInstance;
      }

      if (newInstance.stop) {
        if (def.type === TYPE_TRANSIENT) {
          throw new Error('Service "' + longName.join('.') + '" can\'t have a .stop() method because it is transient.');
        }
        $private(getters).active.push(sharedInstance);
      }

      if (validate) {
        if (existing.validate(newInstance) === false) {
          throw new Error('Service "' + longName.join('.') + '" failed to validate against interface ' + existing.longName.join('.') + '.');
        }
      }
      return newInstance;
    };

    get.longName = longName;

    Object.defineProperty(container, def.name, { enumerable : true, get: get});
  });
  return container;
};

Router.prototype.create =
Router.prototype.init = function (options) {
  var active = [];
  var state = {};
  if (options) {
    Object.keys(options).forEach(function (key) {
      var value = options[key];
      var getter = state[key] = function () { return value; };
      getter.longName = '<parameter: ' + key + '>';
    });
  }
  $private(state).active = active;

  state.ioc = function () {
    return {
      get    : function (name) { return state[name](); },
      inject : function (defn, local) {
        local = local || {};
        var args = annotate(defn).map(function (name) {
          if (local[name] !== undefined) return local[name];
          if (state[name]) return state[name](local);
          throw new Error('Missing dependency: ' + name);
        });
        var newInstance = {};
        return defn.apply(newInstance, args) || newInstance;
      }
    };
  };

  var instance = this.build(state, []);
  instance.stop = function () {
    var results = active.map(function (singletonService) {
      if (singletonService.stop) return singletonService.stop();
    }).filter(Boolean);

    active.splice(0, active.length);
    return P.all(results);
  };
  return instance;
};

function deepSearch(router, name) {
  var defs = $private(router).defs;
  for(var i = 0; i < defs.length; i++) {
    var def = defs[i];
    if (def.type === TYPE_INTERFACE) continue;
    if (def.name === name) return def;
    if (def.type === TYPE_SUBROUTER) {
      var subresult = deepSearch(def.factory, name);
      if (subresult) return subresult;
    }
  }
}

// Methods for testing:
Router.prototype.factory = function (name) {
  var def = deepSearch(this, name);
  return def && function (services) {
    var args = def.deps.map(function (dep) {
      return services[dep];
    });
    var newInstance = {};
    return def.factory.apply(newInstance, args) || newInstance;
  };
};

Router.prototype.inject = function (name, services) {
  return this.factory(name)(services);
};

Router.prototype.define = function (name, defn) {
  if (defn instanceof Router) return this.use(name, defn);
  return this.singleton(name, defn);
};

Router.prototype.constant = function (name, value) {
  return this.singleton(name, function () {
    return value;
  });
};
