(function () {
    'use strict';

    // === КОНФИГУРАЦИЯ И КОНСТАНТЫ ===
    const PLUGIN = {
        id: 'dark_side_ultimate',
        name: 'Dark Side Ultimate',
        version: '3.0.0',
        author: 'Dark Side Community',
        description: 'Продвинутый обход блокировок с множественными адаптерами'
    };

    const STORAGE_KEYS = {
        settings: 'dark_side_ultimate_settings',
        auth: 'dark_side_ultimate_auth',
        balancers: 'dark_side_ultimate_balancers',
        stats: 'dark_side_ultimate_stats'
    };

    // Глобальные переменные
    let originalFetch = null;
    let pluginEnabled = false;
    let currentBalancerIndex = 0;
    let isReady = false;
    let requestQueue = new Map();

    // === НАСТРОЙКИ ПО УМОЛЧАНИЮ ===
    const DEFAULT_CONFIG = {
        enabled: true,
        debug: false,
        timeout: 15000,
        retryCount: 3,
        simpleMode: false,
        encryptionKey: 'lampa_proxy_bypass_key',
        blockedDomainsOnly: true,
        autoSwitchBalancers: true,
        showNotifications: true
    };

    const DEFAULT_BALANCERS = [
        {
            type: 'cloudflare_worker',
            url: 'https://cors.apn.monster/cors/',
            description: 'CORS APN Monster',
            priority: 1,
            enabled: true
        },
        {
            type: 'generic_proxy',
            url: 'https://api.allorigins.win/raw?url=',
            description: 'AllOrigins Proxy',
            priority: 2,
            enabled: true
        },
        {
            type: 'generic_proxy',
            url: 'https://cors-anywhere.herokuapp.com/',
            description: 'CORS Anywhere',
            priority: 3,
            enabled: true
        },
        {
            type: 'url_replace',
            url: 'https://thingproxy.freeboard.io/fetch/',
            description: 'Thing Proxy',
            priority: 4,
            enabled: true
        }
    ];

    const BLOCKED_DOMAINS = [
        'hdrezka.tv', 'hdrezka.ag', 'hdrezka.me', 'rezka.ag',
        'kinogo.biz', 'kinogo.net', 'smotret.online',
        'rutracker.org', 'kinozal.tv', 'nnm-club.me',
        'filmix.ac', 'filmix.me', 'filmix.pro',
        'zetflix.co', 'kinobase.org', 'ivi.tv',
        'okko.tv', 'more.tv', 'start.ru', 'premier.one',
        'wink.ru', 'megogo.net', 'kion.ru',
        'allohacdn', 'fancdn', 'cdnmovies', 'lumex.space',
        'youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv'
    ];

    // === УТИЛИТЫ ХРАНЕНИЯ ===
    const Storage = {
        get: (key, defaultValue = {}) => {
            try {
                return Lampa.Storage ? Lampa.Storage.get(key, defaultValue) : 
                       JSON.parse(localStorage.getItem(key)) || defaultValue;
            } catch (e) {
                return defaultValue;
            }
        },
        set: (key, value) => {
            try {
                if (Lampa.Storage) {
                    Lampa.Storage.set(key, value);
                } else {
                    localStorage.setItem(key, JSON.stringify(value));
                }
            } catch (e) {
                console.error('Storage error:', e);
            }
        }
    };

    // === СОСТОЯНИЕ ПЛАГИНА ===
    let settings = Object.assign({}, DEFAULT_CONFIG, Storage.get(STORAGE_KEYS.settings));
    let customBalancers = Storage.get(STORAGE_KEYS.balancers, []);
    let authSettings = Storage.get(STORAGE_KEYS.auth, {});
    let stats = Storage.get(STORAGE_KEYS.stats, { requests: 0, successes: 0, errors: 0 });

    // === УТИЛИТЫ ===
    function log(...args) {
        if (settings.debug) {
            console.log(`[${PLUGIN.name}]`, ...args);
        }
    }

    function notify(message, type = 'info') {
        if (settings.showNotifications && window.Lampa && Lampa.Noty) {
            Lampa.Noty.show(`${PLUGIN.name}: ${message}`, type);
        }
    }

    function updateStats(type) {
        stats[type]++;
        Storage.set(STORAGE_KEYS.stats, stats);
    }

    // === ПРОВЕРКА БЛОКИРОВКИ ===
    function isBlocked(url) {
        if (!settings.enabled || !url || typeof url !== 'string') return false;
        
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();
            
            // Пропускаем внутренние запросы
            if (hostname === location.hostname || 
                url.includes('localhost') || 
                url.startsWith('/') ||
                url.includes('cdnjs.cloudflare.com') ||
                url.includes('github.io') ||
                url.startsWith('data:') ||
                url.startsWith('blob:')) {
                return false;
            }

            if (!settings.blockedDomainsOnly) return true;

            return BLOCKED_DOMAINS.some(domain => hostname.includes(domain.toLowerCase()));
        } catch (e) {
            log('URL parsing error:', e);
            return false;
        }
    }

    // === ЗАГРУЗКА CRYPTOJS ===
    let cryptoJsPromise = null;
    function loadCryptoJS() {
        if (typeof CryptoJS !== 'undefined') {
            return Promise.resolve(CryptoJS);
        }
        
        if (!cryptoJsPromise) {
            cryptoJsPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js';
                script.onload = () => {
                    log('CryptoJS loaded');
                    resolve(CryptoJS);
                };
                script.onerror = () => reject(new Error('Failed to load CryptoJS'));
                document.head.appendChild(script);
            });
        }
        
        return cryptoJsPromise;
    }

    // === УПРАВЛЕНИЕ БАЛАНСЕРАМИ ===
    function getAllBalancers() {
        const all = [...customBalancers, ...DEFAULT_BALANCERS];
        return all.filter(b => b.enabled).sort((a, b) => a.priority - b.priority);
    }

    function getCurrentBalancer() {
        const balancers = getAllBalancers();
        return balancers[currentBalancerIndex % balancers.length];
    }

    function switchToNextBalancer() {
        const balancers = getAllBalancers();
        if (balancers.length > 1) {
            currentBalancerIndex = (currentBalancerIndex + 1) % balancers.length;
            log(`Switched to balancer: ${getCurrentBalancer()?.description}`);
            if (settings.showNotifications) {
                notify(`Переключен балансер: ${getCurrentBalancer()?.description}`, 'warning');
            }
        }
    }

    // === АВТОРИЗАЦИЯ ===
    function getAuthHeaders(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            for (const [domain, cookie] of Object.entries(authSettings)) {
                if (hostname.includes(domain.toLowerCase())) {
                    return { 'X-Lampa-Auth': cookie };
                }
            }
        } catch (e) {
            log('Auth header error:', e);
        }
        return {};
    }

    // === ПРОКСИРОВАНИЕ ЗАПРОСОВ ===
    async function buildProxyUrl(originalUrl, balancer) {
        const { type, url } = balancer;

        switch (type) {
            case 'cloudflare_worker':
                if (settings.simpleMode) {
                    return `${url}/?url=${encodeURIComponent(originalUrl)}`;
                }
                
                try {
                    const crypto = await loadCryptoJS();
                    const requestData = JSON.stringify({
                        url: originalUrl,
                        timestamp: Date.now()
                    });
                    const encrypted = crypto.AES.encrypt(requestData, settings.encryptionKey).toString();
                    return `${url}/?data=${encodeURIComponent(encrypted)}`;
                } catch (e) {
                    log('Encryption failed, falling back to simple mode:', e);
                    return `${url}/?url=${encodeURIComponent(originalUrl)}`;
                }

            case 'generic_proxy':
                return `${url}${url.includes('?') ? '&' : '?'}url=${encodeURIComponent(originalUrl)}`;

            case 'url_replace':
                return `${url}${originalUrl}`;

            default:
                throw new Error(`Unknown balancer type: ${type}`);
        }
    }

    async function proxyRequest(originalUrl, options = {}) {
        const requestKey = `${options.method || 'GET'}:${originalUrl}`;
        
        // Предотвращаем дублирование запросов
        if (requestQueue.has(requestKey)) {
            log('Request already in progress, waiting...');
            return requestQueue.get(requestKey);
        }

        const requestPromise = (async () => {
            const balancers = getAllBalancers();
            if (!balancers.length) {
                throw new Error('No active balancers available');
            }

            let lastError = null;
            let attempts = 0;
            const maxAttempts = Math.min(settings.retryCount, balancers.length);

            while (attempts < maxAttempts) {
                const balancer = getCurrentBalancer();
                
                try {
                    const proxyUrl = await buildProxyUrl(originalUrl, balancer);
                    
                    const headers = {
                        'User-Agent': 'Lampa/3.0',
                        'Accept': '*/*',
                        ...getAuthHeaders(originalUrl),
                        ...(options.headers || {})
                    };

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), settings.timeout);

                    const response = await originalFetch(proxyUrl, {
                        method: options.method || 'GET',
                        headers,
                        body: options.body,
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (response.ok) {
                        updateStats('successes');
                        log(`Request successful via ${balancer.description}`);
                        return response;
                    }

                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);

                } catch (error) {
                    lastError = error;
                    attempts++;
                    
                    log(`Balancer ${balancer.description} failed:`, error.message);
                    
                    if (settings.autoSwitchBalancers && attempts < maxAttempts) {
                        switchToNextBalancer();
                    }
                }
            }

            updateStats('errors');
            throw lastError || new Error('All balancers failed');
        })();

        requestQueue.set(requestKey, requestPromise);
        
        try {
            updateStats('requests');
            const result = await requestPromise;
            return result;
        } finally {
            requestQueue.delete(requestKey);
        }
    }

    // === ПЕРЕХВАТ FETCH ===
    function interceptFetch() {
        if (originalFetch) return;

        originalFetch = window.fetch;
        window.fetch = async function(url, options = {}) {
            if (isBlocked(url)) {
                log('Intercepting blocked request:', url);
                try {
                    return await proxyRequest(url, options);
                } catch (error) {
                    log('Proxy failed, falling back to original:', error.message);
                    return originalFetch.call(this, url, options);
                }
            }
            return originalFetch.call(this, url, options);
        };

        pluginEnabled = true;
        log('Fetch interceptor activated');
    }

    function restoreFetch() {
        if (originalFetch) {
            window.fetch = originalFetch;
            originalFetch = null;
            pluginEnabled = false;
            log('Fetch interceptor deactivated');
        }
    }

    // === ТЕСТИРОВАНИЕ БАЛАНСЕРОВ ===
    async function testBalancer(balancer, testUrl = 'https://httpbin.org/json') {
        try {
            const start = Date.now();
            const proxyUrl = await buildProxyUrl(testUrl, balancer);
            
            const response = await fetch(proxyUrl, {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000)
            });
            
            const time = Date.now() - start;
            
            return {
                success: response.ok,
                status: response.ok ? 'OK' : `HTTP ${response.status}`,
                time: `${time}ms`,
                description: balancer.description
            };
        } catch (error) {
            return {
                success: false,
                status: 'Failed',
                time: '-',
                description: balancer.description,
                error: error.message
            };
        }
    }

    async function testAllBalancers() {
        const balancers = getAllBalancers();
        const results = [];
        
        for (const balancer of balancers) {
            const result = await testBalancer(balancer);
            results.push(result);
        }
        
        return results;
    }

    // === ИНТЕРФЕЙС НАСТРОЕК ===
    function createSettingsHTML() {
        const balancersHTML = getAllBalancers().map((balancer, index) => `
            <div class="settings-param" data-type="balancer" data-index="${index}">
                <div class="settings-param__name">${balancer.description}</div>
                <div class="settings-param__value">${balancer.enabled ? 'Включен' : 'Отключен'}</div>
                <div class="settings-param__descr">${balancer.type} - Priority: ${balancer.priority}</div>
            </div>
        `).join('');

        return `
            <div class="settings-param selector" data-type="toggle" data-name="enabled">
                <div class="settings-param__name">Включить плагин</div>
                <div class="settings-param__value">${settings.enabled ? 'Включен' : 'Отключен'}</div>
            </div>

            <div class="settings-param selector" data-type="toggle" data-name="debug">
                <div class="settings-param__name">Режим отладки</div>
                <div class="settings-param__value">${settings.debug ? 'Включен' : 'Отключен'}</div>
            </div>

            <div class="settings-param selector" data-type="toggle" data-name="simpleMode">
                <div class="settings-param__name">Простой режим (без шифрования)</div>
                <div class="settings-param__value">${settings.simpleMode ? 'Включен' : 'Отключен'}</div>
            </div>

            <div class="settings-param selector" data-type="toggle" data-name="blockedDomainsOnly">
                <div class="settings-param__name">Только заблокированные домены</div>
                <div class="settings-param__value">${settings.blockedDomainsOnly ? 'Включен' : 'Отключен'}</div>
            </div>

            <div class="settings-param selector" data-type="toggle" data-name="autoSwitchBalancers">
                <div class="settings-param__name">Автопереключение балансеров</div>
                <div class="settings-param__value">${settings.autoSwitchBalancers ? 'Включен' : 'Отключен'}</div>
            </div>

            <div class="settings-param selector" data-type="toggle" data-name="showNotifications">
                <div class="settings-param__name">Показывать уведомления</div>
                <div class="settings-param__value">${settings.showNotifications ? 'Включен' : 'Отключен'}</div>
            </div>

            <div class="settings-param selector" data-type="input" data-name="encryptionKey">
                <div class="settings-param__name">Ключ шифрования</div>
                <div class="settings-param__value">${settings.encryptionKey}</div>
            </div>

            <div class="settings-param selector" data-type="button" data-name="testBalancers">
                <div class="settings-param__name">Тестировать балансеры</div>
                <div class="settings-param__value">Нажмите для проверки</div>
            </div>

            <div class="settings-param selector" data-type="button" data-name="resetStats">
                <div class="settings-param__name">Сбросить статистику</div>
                <div class="settings-param__value">Нажмите для сброса</div>
            </div>

            <div class="settings-param-title">Статистика</div>
            <div class="settings-param__descr">
                Запросов: ${stats.requests} | Успешных: ${stats.successes} | Ошибок: ${stats.errors}
            </div>

            <div class="settings-param-title">Балансеры</div>
            ${balancersHTML}

            <div class="settings-param-title">Заблокированные домены</div>
            <div class="settings-param__descr">${BLOCKED_DOMAINS.join(', ')}</div>
        `;
    }

    function handleSettingAction(type, name, value) {
        switch (name) {
            case 'enabled':
                settings.enabled = value;
                if (value) {
                    interceptFetch();
                    notify('Плагин включен');
                } else {
                    restoreFetch();
                    notify('Плагин отключен');
                }
                break;

            case 'debug':
            case 'simpleMode':
            case 'blockedDomainsOnly':
            case 'autoSwitchBalancers':
            case 'showNotifications':
                settings[name] = value;
                break;

            case 'encryptionKey':
                settings.encryptionKey = value || DEFAULT_CONFIG.encryptionKey;
                break;

            case 'testBalancers':
                runBalancerTest();
                break;

            case 'resetStats':
                stats = { requests: 0, successes: 0, errors: 0 };
                Storage.set(STORAGE_KEYS.stats, stats);
                notify('Статистика сброшена');
                Lampa.Settings.update();
                break;
        }

        Storage.set(STORAGE_KEYS.settings, settings);
    }

    async function runBalancerTest() {
        notify('Тестирование балансеров...');
        
        try {
            const results = await testAllBalancers();
            const successCount = results.filter(r => r.success).length;
            
            let message = `Результат: ${successCount}/${results.length} работают\n\n`;
            results.forEach(r => {
                const status = r.success ? '✅' : '❌';
                message += `${status} ${r.description}: ${r.status} (${r.time})\n`;
            });

            if (window.Lampa && Lampa.Modal) {
                Lampa.Modal.open({
                    title: 'Тест балансеров',
                    html: `<div style="white-space: pre-line; font-family: monospace; color: white;">${message}</div>`,
                    size: 'medium',
                    mask: true,
                    onBack: () => Lampa.Modal.close()
                });
            } else {
                alert(message);
            }
        } catch (error) {
            notify(`Ошибка тестирования: ${error.message}`, 'error');
        }
    }

    // === РЕГИСТРАЦИЯ НАСТРОЕК ===
    function registerSettings() {
        if (!window.Lampa || !Lampa.Settings) return;

        Lampa.Settings.listener.follow('open', (e) => {
            if (e.name === 'main') {
                Lampa.Settings.main().render([{
                    component: PLUGIN.id,
                    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg>',
                    name: PLUGIN.name
                }], 4);
            }
        });

        Lampa.Settings.listener.follow('open', (e) => {
            if (e.name === PLUGIN.id) {
                e.body.find('.settings-param[data-name]').on('hover:enter', function() {
                    const $this = $(this);
                    const name = $this.data('name');
                    const type = $this.data('type');
                    
                    if (type === 'toggle') {
                        const currentValue = settings[name];
                        const newValue = !currentValue;
                        handleSettingAction('toggle', name, newValue);
                        $this.find('.settings-param__value').text(newValue ? 'Включен' : 'Отключен');
                        
                    } else if (type === 'input') {
                        Lampa.Input.edit({
                            title: 'Введите значение',
                            value: settings[name] || '',
                            free: true,
                            nosave: true
                        }, (value) => {
                            handleSettingAction('input', name, value);
                            $this.find('.settings-param__value').text(value || 'Не задано');
                        });
                        
                    } else if (type === 'button') {
                        handleSettingAction('button', name);
                    }
                });
            }
        });

        Lampa.Settings.create({
            component: PLUGIN.id,
            name: PLUGIN.name,
            html: createSettingsHTML()
        });
    }

    // === ПУБЛИЧНЫЙ API ===
    function getAPI() {
        return {
            version: PLUGIN.version,
            isEnabled: () => settings.enabled,
            isReady: () => isReady,
            getSettings: () => ({ ...settings }),
            updateSettings: (newSettings) => {
                Object.assign(settings, newSettings);
                Storage.set(STORAGE_KEYS.settings, settings);
            },
            getBalancers: getAllBalancers,
            getCurrentBalancer,
            switchBalancer: switchToNextBalancer,
            testBalancer,
            testAllBalancers,
            getStats: () => ({ ...stats }),
            resetStats: () => {
                stats = { requests: 0, successes: 0, errors: 0 };
                Storage.set(STORAGE_KEYS.stats, stats);
            },
            proxyRequest,
            isBlocked
        };
    }

    // === ИНИЦИАЛИЗАЦИЯ ===
    function initialize() {
        try {
            log('Initializing plugin...');

            // Регистрируем настройки
            registerSettings();

            // Активируем плагин если включен
            if (settings.enabled) {
                interceptFetch();
            }

            isReady = true;
            log('Plugin initialized successfully');
            notify('Плагин инициализирован');

            // Глобальный API для отладки
            window.DarkSideAPI = getAPI();

        } catch (error) {
            console.error(`${PLUGIN.name} initialization failed:`, error);
            notify('Ошибка инициализации плагина', 'error');
        }
    }

    // === РЕГИСТРАЦИЯ ПЛАГИНА ===
    if (window.Lampa && Lampa.Plugin) {
        Lampa.Plugin.add(PLUGIN.id, {
            name: PLUGIN.name,
            version: PLUGIN.version,
            author: PLUGIN.author,
            description: PLUGIN.description,
            
            init: initialize,
            
            destroy: () => {
                restoreFetch();
                isReady = false;
                log('Plugin destroyed');
            },
            
            getAPI
        });
    } else {
        // Fallback для случаев когда Lampa еще не загружена
        document.addEventListener('DOMContentLoaded', () => {
            if (window.Lampa && Lampa.Plugin) {
                initialize();
            }
        });
    }

    log(`${PLUGIN.name} v${PLUGIN.version} loaded`);

})();
