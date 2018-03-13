// import { remote } from 'electron';
import { action, computed, observable } from 'mobx';
import { debounce, remove } from 'lodash';
// import path from 'path';
// import fs from 'fs-extra';

import Store from './lib/Store';
import Request from './lib/Request';
import CachedRequest from './lib/CachedRequest';
import { matchRoute } from '../helpers/routing-helpers';
import { gaEvent } from '../lib/analytics';

export default class ServiceGroupsStore extends Store {
  @observable allServiceGroupsRequest = new CachedRequest(this.api.serviceGroups, 'all');
  @observable createServiceGroupRequest = new Request(this.api.serviceGroups, 'create');
  @observable updateServiceGroupRequest = new Request(this.api.serviceGroups, 'update');
  @observable reorderServiceGroupsRequest = new Request(this.api.serviceGroups, 'reorder');
  @observable deleteServiceGroupRequest = new Request(this.api.serviceGroups, 'delete');

  @observable filterNeedle = null;

  constructor(...args) {
    super(...args);

    // Register action handlers
    this.actions.serviceGroup.createServiceGroup.listen(this._createServiceGroup.bind(this));
    this.actions.serviceGroup.updateServiceGroup.listen(this._updateServiceGroup.bind(this));
    this.actions.serviceGroup.deleteServiceGroup.listen(this._deleteServiceGroup.bind(this));
    // this.actions.serviceGroup.reorder.listen(this._reorder.bind(this));

    this.registerReactions([
    ]);
  }

  @computed get all() {
    if (this.stores.user.isLoggedIn) {
      const serviceGroups = this.allServiceGroupsRequest.execute().result;
      if (serviceGroups) {
        return observable(serviceGroups);//.slice().slice().sort((a, b) => a.order - b.order));
      }
    }

    return [];
  }

  @computed get enabled() {
    return this.all.filter(service => service.isEnabled);
  }

  @computed get allDisplayed() {
    return this.stores.settings.all.showDisabledServices ? this.all : this.enabled;
  }

  @computed get filtered() {
    return this.all.filter(service => service.name.toLowerCase().includes(this.filterNeedle.toLowerCase()));
  }

  @computed get active() {
    return this.all.find(service => service.isActive);
  }

  @computed get activeSettings() {
    const match = matchRoute('/settings/services/edit/:id', this.stores.router.location.pathname);
    if (match) {
      const activeService = this.one(match.id);
      if (activeService) {
        return activeService;
      }

      console.warn('Service not available');
    }

    return null;
  }

  one(id) {
    return this.all.find(serviceGroup => serviceGroup.id === id);
  }

  // Actions
  @action async _createServiceGroup({ serviceGroupData, redirect }) {
    const response = await this.createServiceGroupRequest.execute(serviceGroupData)._promise;

    this.allServiceGroupsRequest.patch((result) => {
      if (!result) return;
      result.push(response.data);
    });

    this.actionStatus = response.status || [];

    if (redirect) {
      this.stores.router.push('/settings/services');
      gaEvent('Service Group', 'create');
    }
  }

  @action async _updateServiceGroup({ serviceGroupId, serviceGroupData, redirect }) {
    const service = this.one(serviceId);
    const request = this.updateServiceRequest.execute(serviceId, data);

    this.allServicesRequest.patch((result) => {
      if (!result) return;

      Object.assign(result.find(c => c.id === serviceId), newData);
    });

    await request._promise;
    this.actionStatus = request.result.status;

    if (redirect) {
      this.stores.router.push('/settings/services');
      gaEvent('Service', 'update', service.recipe.id);
    }
  }

  @action async _deleteServiceGroup({ serviceGroupId, redirect }) {
    const request = this.deleteServiceGroupRequest.execute(serviceGroupId);

    if (redirect) {
      this.stores.router.push(redirect);
    }

    this.allServiceGroupsRequest.patch((result) => {
      remove(result, c => c.id === serviceGroupId);
    });

    await request._promise;
    this.actionStatus = request.result.status;

    gaEvent('Service Group', 'delete');
  }

  @action _setActive({ serviceId }) {
    const service = this.one(serviceId);

    this.all.forEach((s, index) => {
      this.all[index].isActive = false;
    });
    service.isActive = true;
  }

  @action _setActiveNext() {
    const nextIndex = this._wrapIndex(this.allDisplayed.findIndex(service => service.isActive), 1, this.allDisplayed.length);

    // TODO: simplify this;
    this.all.forEach((s, index) => {
      this.all[index].isActive = false;
    });
    this.allDisplayed[nextIndex].isActive = true;
  }

  @action _setActivePrev() {
    const prevIndex = this._wrapIndex(this.allDisplayed.findIndex(service => service.isActive), -1, this.allDisplayed.length);

    // TODO: simplify this;
    this.all.forEach((s, index) => {
      this.all[index].isActive = false;
    });
    this.allDisplayed[prevIndex].isActive = true;
  }

  @action _setUnreadMessageCount({ serviceId, count }) {
    const service = this.one(serviceId);

    service.unreadDirectMessageCount = count.direct;
    service.unreadIndirectMessageCount = count.indirect;
  }

  @action _focusService({ serviceId }) {
    const service = this.one(serviceId);

    if (service.webview) {
      service.webview.focus();
    }
  }

  @action _focusActiveService() {
    if (this.stores.user.isLoggedIn) {
      // TODO: add checks to not focus service when router path is /settings or /auth
      const service = this.active;
      if (service) {
        this._focusService({ serviceId: service.id });
      }
    } else {
      this.allServicesRequest.invalidate();
    }
  }

  @action _toggleService({ serviceId }) {
    const service = this.one(serviceId);

    service.isEnabled = !service.isEnabled;
  }

  @action _handleIPCMessage({ serviceId, channel, args }) {
    const service = this.one(serviceId);

    if (channel === 'hello') {
      this._initRecipePolling(service.id);
      this._initializeServiceRecipeInWebview(serviceId);
      this._shareSettingsWithServiceProcess();
    } else if (channel === 'messages') {
      this.actions.service.setUnreadMessageCount({
        serviceId,
        count: {
          direct: args[0].direct,
          indirect: args[0].indirect,
        },
      });
    } else if (channel === 'notification') {
      const options = args[0].options;
      if (service.recipe.hasNotificationSound || service.isMuted || this.stores.settings.all.isAppMuted) {
        Object.assign(options, {
          silent: true,
        });
      }

      if (service.isNotificationEnabled) {
        const title = typeof args[0].title === 'string' ? args[0].title : service.name;
        options.body = typeof options.body === 'string' ? options.body : '';

        this.actions.app.notify({
          notificationId: args[0].notificationId,
          title,
          options,
          serviceId,
        });
      }
    } else if (channel === 'avatar') {
      const url = args[0];
      if (service.iconUrl !== url && !service.hasCustomUploadedIcon) {
        service.customIconUrl = url;

        this.actions.service.updateService({
          serviceId,
          serviceData: {
            customIconUrl: url,
          },
          redirect: false,
        });
      }
    } else if (channel === 'new-window') {
      const url = args[0];

      this.actions.app.openExternalUrl({ url });
    }
  }

  @action _sendIPCMessage({ serviceId, channel, args }) {
    const service = this.one(serviceId);

    if (service.webview) {
      service.webview.send(channel, args);
    }
  }

  @action _sendIPCMessageToAllServices({ channel, args }) {
    this.all.forEach(s => this.actions.service.sendIPCMessage({
      serviceId: s.id,
      channel,
      args,
    }));
  }

  @action _openWindow({ event }) {
    if (event.disposition !== 'new-window' && event.url !== 'about:blank') {
      this.actions.app.openExternalUrl({ url: event.url });
    }
  }

  @action _filter({ needle }) {
    this.filterNeedle = needle;
  }

  @action _resetFilter() {
    this.filterNeedle = null;
  }

  @action _resetStatus() {
    this.actionStatus = [];
  }

  @action _reload({ serviceId }) {
    const service = this.one(serviceId);
    service.resetMessageCount();

    service.webview.loadURL(service.url);
  }

  @action _reloadActive() {
    if (this.active) {
      const service = this.one(this.active.id);

      this._reload({
        serviceId: service.id,
      });
    }
  }

  @action _reloadAll() {
    this.enabled.forEach(s => this._reload({
      serviceId: s.id,
    }));
  }

  @action _reloadUpdatedServices() {
    this._reloadAll();
    this.actions.ui.toggleServiceUpdatedInfoBar({ visible: false });
  }

  @action _reorder({ oldIndex, newIndex }) {
    const showDisabledServices = this.stores.settings.all.showDisabledServices;
    const oldEnabledSortIndex = showDisabledServices ? oldIndex : this.all.indexOf(this.enabled[oldIndex]);
    const newEnabledSortIndex = showDisabledServices ? newIndex : this.all.indexOf(this.enabled[newIndex]);

    this.all.splice(newEnabledSortIndex, 0, this.all.splice(oldEnabledSortIndex, 1)[0]);

    const services = {};
    this.all.forEach((s, index) => {
      services[this.all[index].id] = index;
    });

    this.reorderServicesRequest.execute(services);
    this.allServicesRequest.patch((data) => {
      data.forEach((s) => {
        const service = s;

        service.order = services[s.id];
      });
    });

    this._reorderAnalytics();
  }

  @action _toggleNotifications({ serviceId }) {
    const service = this.one(serviceId);

    this.actions.service.updateService({
      serviceId,
      serviceData: {
        isNotificationEnabled: !service.isNotificationEnabled,
      },
      redirect: false,
    });
  }

  @action _toggleAudio({ serviceId }) {
    const service = this.one(serviceId);

    service.isNotificationEnabled = !service.isNotificationEnabled;

    this.actions.service.updateService({
      serviceId,
      serviceData: {
        isMuted: !service.isMuted,
      },
      redirect: false,
    });
  }

  @action _openDevTools({ serviceId }) {
    const service = this.one(serviceId);

    service.webview.openDevTools();
  }

  @action _openDevToolsForActiveService() {
    const service = this.active;

    if (service) {
      service.webview.openDevTools();
    } else {
      console.warn('No service is active');
    }
  }

  // Reactions
  _focusServiceReaction() {
    const service = this.active;
    if (service) {
      this.actions.service.focusService({ serviceId: service.id });
    }
  }

  _saveActiveService() {
    const service = this.active;

    if (service) {
      this.actions.settings.update({
        settings: {
          activeService: service.id,
        },
      });
    }
  }

  _mapActiveServiceToServiceModelReaction() {
    const { activeService } = this.stores.settings.all;
    if (this.allDisplayed.length) {
      this.allDisplayed.map(service => Object.assign(service, {
        isActive: activeService ? activeService === service.id : this.allDisplayed[0].id === service.id,
      }));
    }
  }

  _getUnreadMessageCountReaction() {
    const showMessageBadgeWhenMuted = this.stores.settings.all.showMessageBadgeWhenMuted;
    const showMessageBadgesEvenWhenMuted = this.stores.ui.showMessageBadgesEvenWhenMuted;

    const unreadDirectMessageCount = this.allDisplayed
      .filter(s => (showMessageBadgeWhenMuted || s.isNotificationEnabled) && showMessageBadgesEvenWhenMuted && s.isBadgeEnabled)
      .map(s => s.unreadDirectMessageCount)
      .reduce((a, b) => a + b, 0);

    const unreadIndirectMessageCount = this.allDisplayed
      .filter(s => (showMessageBadgeWhenMuted && showMessageBadgesEvenWhenMuted) && (s.isBadgeEnabled && s.isIndirectMessageBadgeEnabled))
      .map(s => s.unreadIndirectMessageCount)
      .reduce((a, b) => a + b, 0);

    // We can't just block this earlier, otherwise the mobx reaction won't be aware of the vars to watch in some cases
    if (showMessageBadgesEvenWhenMuted) {
      this.actions.app.setBadge({
        unreadDirectMessageCount,
        unreadIndirectMessageCount,
      });
    }
  }

  _logoutReaction() {
    if (!this.stores.user.isLoggedIn) {
      this.actions.settings.remove({ key: 'activeService' });
      this.allServicesRequest.invalidate().reset();
    }
  }

  _shareSettingsWithServiceProcess() {
    this.actions.service.sendIPCMessageToAllServices({
      channel: 'settings-update',
      args: this.stores.settings.all,
    });
  }

  _cleanUpTeamIdAndCustomUrl(recipeId, data) {
    const serviceData = data;
    const recipe = this.stores.recipes.one(recipeId);

    if (recipe.hasTeamId && recipe.hasCustomUrl && data.team && data.customUrl) {
      delete serviceData.team;
    }

    return serviceData;
  }

  // Helper
  _redirectToAddServiceRoute(recipeId) {
    const route = `/settings/services/add/${recipeId}`;
    this.stores.router.push(route);
  }

  _initializeServiceRecipeInWebview(serviceId) {
    const service = this.one(serviceId);

    if (service.webview) {
      service.webview.send('initializeRecipe', service);
    }
  }

  _initRecipePolling(serviceId) {
    const service = this.one(serviceId);

    const delay = 1000;

    if (service) {
      if (service.timer !== null) {
        clearTimeout(service.timer);
      }

      const loop = () => {
        if (!service.webview) return;

        service.webview.send('poll');

        service.timer = setTimeout(loop, delay);
      };

      loop();
    }
  }

  _reorderAnalytics = debounce(() => {
    gaEvent('Service', 'order');
  }, 5000);

  _wrapIndex(index, delta, size) {
    return (((index + delta) % size) + size) % size;
  }
}