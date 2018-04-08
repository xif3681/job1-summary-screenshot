import _ from 'lodash';
import angular from 'angular';
import rison from 'rison-node';
import registry from 'plugins/kibana/management/saved_object_registry';
import objectViewHTML from 'plugins/kibana/management/sections/objects/_view.html';
import IndexPatternsCastMappingTypeProvider from 'ui/index_patterns/_cast_mapping_type';
import uiRoutes from 'ui/routes';
import uiModules from 'ui/modules';

uiRoutes
.when('/management/kibana/objects/:service/:id', {
  template: objectViewHTML
});

uiModules.get('apps/management')
.directive('kbnManagementObjectsView', function (kbnIndex, Notifier) {
  return {
    restrict: 'E',
    controller: function ($scope, $injector, $routeParams, $location, $window, $rootScope, es, Private,$translate,$translatePartialLoader) {
      var savedObjectView = $translate.instant('SavedObject view');
      const notify = new Notifier({ location: savedObjectView });
      const castMappingType = Private(IndexPatternsCastMappingTypeProvider);
      const serviceObj = registry.get($routeParams.service);
      const service = $injector.get(serviceObj.service);
      $translatePartialLoader.addPart('../plugins/kibana/management/sections/objects');
      $translate.refresh();
      /**
       * Creates a field definition and pushes it to the memo stack. This function
       * is designed to be used in conjunction with _.reduce(). If the
       * values is plain object it will recurse through all the keys till it hits
       * a string, number or an array.
       *
       * @param {array} memo The stack of fields
       * @param {mixed} value The value of the field
       * @param {string} key The key of the field
       * @param {object} collection This is a reference the collection being reduced
       * @param {array} parents The parent keys to the field
       * @returns {array}
       */
      const createField = function (memo, val, key, collection, parents) {
        if (_.isArray(parents)) {
          parents.push(key);
        } else {
          parents = [key];
        }

        const field = { type: 'text', name: parents.join('.'), value: val };

        if (_.isString(field.value)) {
          try {
            field.value = angular.toJson(JSON.parse(field.value), true);
            field.type = 'json';
          } catch (err) {
            field.value = field.value;
          }
        } else if (_.isNumeric(field.value)) {
          field.type = 'number';
        } else if (_.isArray(field.value)) {
          field.type = 'array';
          field.value = angular.toJson(field.value, true);
        } else if (_.isBoolean(field.value)) {
          field.type = 'boolean';
          field.value = field.value;
        } else if (_.isPlainObject(field.value)) {
          // do something recursive
          return _.reduce(field.value, _.partialRight(createField, parents), memo);
        }

        memo.push(field);

        // once the field is added to the object you need to pop the parents
        // to remove it since we've hit the end of the branch.
        parents.pop();
        return memo;
      };

      const readObjectClass = function (fields, Class) {
        const fieldMap = _.indexBy(fields, 'name');

        _.forOwn(Class.mapping, function (esType, name) {
          if (fieldMap[name]) return;

          fields.push({
            name: name,
            type: (function () {
              switch (castMappingType(esType)) {
                case 'string': return 'text';
                case 'number': return 'number';
                case 'boolean': return 'boolean';
                default: return 'json';
              }
            }())
          });
        });

        if (Class.searchSource && !fieldMap['kibanaSavedObjectMeta.searchSourceJSON']) {
          fields.push({
            name: 'kibanaSavedObjectMeta.searchSourceJSON',
            type: 'json',
            value: '{}'
          });
        }
      };

      $scope.notFound = $routeParams.notFound;

      $scope.title = service.type;

      // @tian.yuanfeng@eisoo.com  2016.8.29
      var curTitle = $scope.title;
      var lang = $translate.use();
      if(lang === 'zh-cn') {
        switch(curTitle)
        {
          case 'dashboard':
            curTitle = '仪表盘';
            break;
          case 'search':
            curTitle = '搜索';
            break;
          default:
            curTitle = '可视化';
        }
      }else if(lang === 'zh-tw'){
        switch(curTitle)
        {
          case 'dashboard':
            curTitle = '儀錶盤';
            break;
          case 'search':
            curTitle = '搜索';
            break;
          default:
            curTitle = '視覺化';
        }
      }else {
        curTitle = $scope.title;
      }

      $scope.translationTitle = {
        title: curTitle
      };
      es.get({
        index: kbnIndex,
        type: service.type,
        id: $routeParams.id
      })
      .then(function (obj) {
        $scope.obj = obj;
        $scope.link = service.urlFor(obj._id);

        const fields =  _.reduce(obj._source, createField, []);
        if (service.Class) readObjectClass(fields, service.Class);
        $scope.fields = _.sortBy(fields, 'name');
      })
      .catch(notify.fatal);

      // This handles the validation of the Ace Editor. Since we don't have any
      // other hooks into the editors to tell us if the content is valid or not
      // we need to use the annotations to see if they have any errors. If they
      // do then we push the field.name to aceInvalidEditor variable.
      // Otherwise we remove it.
      const loadedEditors = [];
      $scope.aceInvalidEditors = [];

      $scope.aceLoaded = function (editor) {
        if (_.contains(loadedEditors, editor)) return;
        loadedEditors.push(editor);

        editor.$blockScrolling = Infinity;

        const session = editor.getSession();
        const fieldName = editor.container.id;

        session.setTabSize(2);
        session.setUseSoftTabs(true);
        session.on('changeAnnotation', function () {
          const annotations = session.getAnnotations();
          if (_.some(annotations, { type: 'error'})) {
            if (!_.contains($scope.aceInvalidEditors, fieldName)) {
              $scope.aceInvalidEditors.push(fieldName);
            }
          } else {
            $scope.aceInvalidEditors = _.without($scope.aceInvalidEditors, fieldName);
          }

          if ($rootScope.$$phase) $scope.$apply();
        });
      };

      $scope.cancel = function () {
        $window.history.back();
        return false;
      };

      /**
       * Deletes an object and sets the notification
       * @param {type} name description
       * @returns {type} description
       */
      $scope.delete = function () {
        es.delete({
          index: kbnIndex,
          type: service.type,
          id: $routeParams.id
        })
        .then(function (resp) {
          return redirectHandler('deleted');
        })
        .catch(notify.fatal);
      };

      $scope.submit = function () {
        const source = _.cloneDeep($scope.obj._source);

        _.each($scope.fields, function (field) {
          let value = field.value;

          if (field.type === 'number') {
            value = Number(field.value);
          }

          if (field.type === 'array') {
            value = JSON.parse(field.value);
          }

          _.set(source, field.name, value);
        });

        es.index({
          index: kbnIndex,
          type: service.type,
          id: $routeParams.id,
          body: source
        })
        .then(function (resp) {
          return redirectHandler('updated');
        })
        .catch(notify.fatal);
      };

      function redirectHandler(action) {
        return es.indices.refresh({
          index: kbnIndex
        })
        .then(function (resp) {
            // @tian.yuanfeng@eisoo.com  2016.8.29
            // const msg = 'You successfully ' + action + ' the "' + $scope.obj._source.title + '" ' + $scope.title.toLowerCase() + ' object';

          var actionSuccess = null;
          if(action === 'updated') {
            actionSuccess = $translate.instant('You successfully updated the');
          }else if(action === 'deleted') {
            actionSuccess = $translate.instant('You successfully deleted the');
          }

          // @tian.yuanfeng@eisoo.com  2016.8.29
          var curTitleLower = $scope.title.toLowerCase();
          var lang = $translate.use();
          var curTitleObject;
          if(lang === 'zh-cn') {
            switch(curTitleLower)
            {
              case 'dashboard':
                curTitleObject = '仪表盘对象';
                break;
              case 'search':
                curTitleObject = '搜索对象';
                break;
              default:
                curTitleObject = '可视化对象';
            }
          }else if(lang === 'zh-tw') {
            switch(curTitleLower)
            {
              case 'dashboard':
                curTitleObject = '儀錶盤對象';
                break;
              case 'search':
                curTitleObject = '搜索對象';
                break;
              default:
                curTitleObject = '視覺化對象';
            }
          }else {
            curTitleObject = $scope.title.toLowerCase() + ' object';
          }

          const msg =  actionSuccess +  ' "' + $scope.obj._source.title + '" '  + curTitleObject;


          $location.path('/management/kibana/objects').search({
            _a: rison.encode({
              tab: serviceObj.title
            })
          });
          notify.info(msg);
        });
      }
    }
  };
});
