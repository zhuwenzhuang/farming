(() => {
  'use strict';

  const copy = {
    en: {
      checking: 'Checking',
      count: count => `${count} ${count === 1 ? 'environment' : 'environments'}`,
      defaultSubtitle: 'All your deployed Farming workspaces, one click away.',
      emptyBody: 'Try another name, owner, or platform.',
      emptyTitle: 'No matching environment',
      environments: 'Environments',
      eyebrow: 'YOUR FARMING NETWORK',
      failed: 'Farming Net could not load its private registry. Refresh to try again.',
      footer: 'One portal token. Short-lived passes for enrolled Farms.',
      justUpdated: 'Updated just now',
      privateIndex: 'Private index',
      reachable: 'Reachable',
      refresh: 'Refresh',
      scope: {
        'this-device': 'THIS DEVICE',
        intranet: 'INTRANET',
        remote: 'REMOTE',
        tunnel: 'TUNNEL',
      },
      searchPlaceholder: 'Search environments',
      unknown: 'Not verified',
    },
    zh: {
      checking: '检查中',
      count: count => `${count} 个环境`,
      defaultSubtitle: '所有已经部署的 Farming，一个入口。',
      emptyBody: '试试搜索环境名、所有者或平台。',
      emptyTitle: '没有匹配的环境',
      environments: '环境',
      eyebrow: '你的 FARMING 网络',
      failed: 'Farming Net 暂时无法读取私有环境列表，请刷新重试。',
      footer: '一个门户 Token，短时通行已登记的 Farming。',
      justUpdated: '刚刚更新',
      privateIndex: '私有门户',
      reachable: '可访问',
      refresh: '刷新',
      scope: {
        'this-device': '本机',
        intranet: '内网',
        remote: '远程',
        tunnel: '隧道',
      },
      searchPlaceholder: '搜索环境',
      unknown: '未确认',
    },
  };

  const language = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  const t = copy[language];
  const state = {
    query: '',
    registry: { title: 'Farming Net', subtitle: '', instances: [] },
    availability: new Map(),
  };

  const elements = {
    count: document.getElementById('instance-count'),
    empty: document.getElementById('empty-state'),
    grid: document.getElementById('instance-grid'),
    notice: document.getElementById('notice'),
    refresh: document.querySelector('[data-testid="net-refresh"]'),
    search: document.querySelector('[data-testid="net-search"]'),
    subtitle: document.getElementById('portal-subtitle'),
    title: document.getElementById('portal-title'),
    updated: document.getElementById('last-updated'),
  };

  function applyCopy() {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-copy]').forEach(element => {
      const value = t[element.dataset.copy];
      if (typeof value === 'string') element.textContent = value;
    });
    document.querySelectorAll('[data-copy-placeholder]').forEach(element => {
      const value = t[element.dataset.copyPlaceholder];
      if (typeof value === 'string') element.setAttribute('placeholder', value);
    });
  }

  function cardSearchText(instance) {
    return [
      instance.name,
      instance.owner,
      instance.platform,
      instance.description,
      ...instance.endpoints.map(endpoint => `${endpoint.label} ${endpoint.scope}`),
    ].join(' ').toLocaleLowerCase();
  }

  function displayedInstances() {
    const query = state.query.trim().toLocaleLowerCase();
    const instances = [...state.registry.instances].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return left.name.localeCompare(right.name, language === 'zh' ? 'zh-CN' : 'en');
    });
    if (!query) return instances;
    return instances.filter(instance => cardSearchText(instance).includes(query));
  }

  function initials(name) {
    const parts = Array.from(String(name || '').trim());
    return parts.slice(0, 2).join('').toUpperCase() || 'F';
  }

  function availabilityElement(instance) {
    const status = state.availability.get(instance.id) || 'checking';
    const element = document.createElement('span');
    element.className = 'availability';
    element.dataset.state = status;
    element.dataset.testid = `net-status-${instance.id}`;

    const dot = document.createElement('span');
    dot.className = 'availability-dot';
    dot.setAttribute('aria-hidden', 'true');
    element.append(dot);

    const label = document.createElement('span');
    label.textContent = status === 'reachable' ? t.reachable : status === 'checking' ? t.checking : t.unknown;
    element.append(label);
    return element;
  }

  function endpointElement(instance, endpoint, endpointIndex) {
    const link = document.createElement('a');
    link.className = 'endpoint-link';
    link.href = endpoint.launchUrl || endpoint.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.testid = endpointIndex === 0 ? `net-open-${instance.id}` : `net-open-${instance.id}-${endpointIndex + 1}`;

    const label = document.createElement('span');
    label.className = 'endpoint-label';
    label.textContent = endpoint.label;
    link.append(label);

    const scope = document.createElement('span');
    scope.className = 'endpoint-scope';
    scope.textContent = t.scope[endpoint.scope] || t.scope.remote;
    link.append(scope);

    const arrow = document.createElement('span');
    arrow.className = 'endpoint-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    link.append(arrow);
    return link;
  }

  function instanceElement(instance) {
    const card = document.createElement('article');
    card.className = 'instance-card';
    card.dataset.testid = `net-instance-card-${instance.id}`;

    const topline = document.createElement('div');
    topline.className = 'card-topline';
    const avatar = document.createElement('div');
    avatar.className = 'instance-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(instance.name);
    topline.append(avatar, availabilityElement(instance));
    card.append(topline);

    const title = document.createElement('h3');
    title.textContent = instance.name;
    card.append(title);

    const metadata = document.createElement('p');
    metadata.className = 'instance-meta';
    metadata.textContent = [instance.owner, instance.platform].filter(Boolean).join(' · ');
    card.append(metadata);

    const description = document.createElement('p');
    description.className = 'instance-description';
    description.textContent = instance.description || '\u00a0';
    card.append(description);

    const endpointList = document.createElement('div');
    endpointList.className = 'endpoint-list';
    instance.endpoints.forEach((endpoint, index) => endpointList.append(endpointElement(instance, endpoint, index)));
    card.append(endpointList);
    return card;
  }

  function render() {
    const instances = displayedInstances();
    elements.grid.replaceChildren(...instances.map(instanceElement));
    elements.grid.setAttribute('aria-busy', 'false');
    elements.empty.hidden = instances.length !== 0;
    elements.count.textContent = t.count(instances.length);
  }

  async function probeInstance(instance) {
    const endpoint = instance.endpoints.find(item => item.primary) || instance.endpoints[0];
    if (!endpoint) return;
    const controller = new window.AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const statusUrl = new URL('api/auth/status', endpoint.url);
      await fetch(statusUrl, {
        cache: 'no-store',
        credentials: 'include',
        mode: 'no-cors',
        signal: controller.signal,
      });
      state.availability.set(instance.id, 'reachable');
    } catch {
      state.availability.set(instance.id, 'unknown');
    } finally {
      window.clearTimeout(timeout);
      render();
    }
  }

  async function loadRegistry() {
    elements.notice.hidden = true;
    elements.refresh.disabled = true;
    elements.refresh.classList.add('is-loading');
    elements.grid.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('api/instances', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Registry request failed with ${response.status}`);
      const registry = await response.json();
      state.registry = registry;
      state.availability = new Map(registry.instances.map(instance => [instance.id, 'checking']));
      elements.title.textContent = registry.title || 'Farming Net';
      elements.subtitle.textContent = registry.subtitle || t.defaultSubtitle;
      document.title = registry.title || 'Farming Net';
      elements.updated.textContent = t.justUpdated;
      render();
      registry.instances.forEach(instance => void probeInstance(instance));
    } catch (error) {
      console.error(error);
      state.registry = { title: 'Farming Net', subtitle: '', instances: [] };
      elements.notice.textContent = t.failed;
      elements.notice.hidden = false;
      render();
    } finally {
      elements.refresh.disabled = false;
      elements.refresh.classList.remove('is-loading');
    }
  }

  elements.search.addEventListener('input', event => {
    state.query = event.target.value;
    render();
  });
  elements.refresh.addEventListener('click', () => void loadRegistry());
  document.addEventListener('keydown', event => {
    if (event.key === '/' && document.activeElement !== elements.search) {
      event.preventDefault();
      elements.search.focus();
    }
    if (event.key === 'Escape' && document.activeElement === elements.search) {
      elements.search.value = '';
      state.query = '';
      render();
      elements.search.blur();
    }
  });

  applyCopy();
  void loadRegistry();
})();
