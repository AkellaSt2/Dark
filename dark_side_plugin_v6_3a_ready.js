
/*!
 * Dark Side v6.3a — multi-source aggregator for Lampa
 * - Delayed initialization until Lampa.Source ready
 * - Menu refresh after adding source
 * - Allow HTTP imports (no https restriction)
 * - TEST_JSON_URL points to placeholder JSON file (user must replace with actual raw link)
 * 2025-08-13
 */
(function(){
  'use strict';

  const ID = 'dark_side_v6';
  const TITLE = 'Dark Side';
  const VERSION = '6.3.1';
  const PREF_KEY = 'dark_side_v6_prefs';
  const MENU_COLOR = '#303030';
  const TEST_JSON_URL = 'https://raw.githubusercontent.com/USERNAME/REPO/BRANCH/path/to/darkside_test_extended.json';

  const Storage = (window.Lampa && Lampa.Storage) ? Lampa.Storage : {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch(e){ return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
  };
  const Noty = (window.Lampa && Lampa.Noty) ? Lampa.Noty.show.bind(Lampa.Noty) : (msg)=>console.log('[DarkSide Noty]', msg);

  function readPrefs(){ 
    return Object.assign({
      enabled: true,
      override_all_sources: false,
      preferred_quality: '2160p',
      omdb_key: 'demo',
      enable_adapters: { omdb:true, ia:true, blender:true, nasa:false },
      external_adapters: [],
      extended_enabled: false,
      extended_catalog: [
        { key:'mods_like_source',     name:'MODS-like adapter',  desc:'⚠️ Сторонний адаптер (серый). Требует внешний URL.', url:'', enabled:false },
        { key:'skaz_like_source',     name:'Skaz-like adapter',  desc:'⚠️ Сторонний адаптер (серый). Требует внешний URL.', url:'', enabled:false },
        { key:'online_mod_like',      name:'OnlineMod-like',     desc:'⚠️ Сторонний адаптер (серый). Требует внешний URL.', url:'', enabled:false }
      ]
    }, Storage.get(PREF_KEY, {}));
  }
  function writePrefs(p){ Storage.set(PREF_KEY, p); }
  const prefs = readPrefs();

  function log(...a){ try{ console.log('[DarkSide v6.3a]', ...a);}catch(e){} }
  const fetchJSON = (u,opt={}) => fetch(u,opt).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); });

  const Registry = { adapters:{}, add(n,impl){ this.adapters[n]=impl; }, list(){ return Object.keys(this.adapters); } };

  // minimal built-in OMDb adapter for placeholder
  Registry.add('omdb', {
    search: async (q)=>[],
    details: async (m)=>m,
    resolve: async ()=>[]
  });

  async function loadExternalAdapters(){
    const list = [];
    (prefs.external_adapters||[]).forEach(x=>{ if(x.enabled && x.url) list.push(x.url); });
    if(prefs.extended_enabled){ (prefs.extended_catalog||[]).forEach(x=>{ if(x.enabled && x.url) list.push(x.url); }); }
    for(const url of list){ 
      try{ await import(url); log('Loaded external adapter:', url); }
      catch(e){ log('Fail load', url, e); }
    }
  }
  window.registerDarkSideAdapter = function(name, impl){ Registry.add(name, impl); log('External adapter registered:', name); };

  function ensureMenuSource(){
    if(!Lampa || !Lampa.Source) return false;
    const src = {
      title: TITLE, type: 'online', background: MENU_COLOR,
      search: async (q, cb, done)=>{ await loadExternalAdapters(); cb([]); done(); },
      details: async (m, cb)=>cb(m),
      play: async (m, cb)=>cb([])
    };
    if(Lampa.Source.add) {
      Lampa.Source.add(ID, src);
      log('Source registered');
      if(Lampa.Menu && Lampa.Menu.update){ Lampa.Menu.update(); log('Menu refreshed'); }
    }
    return true;
  }

  function importFromJSON(url){
    fetchJSON(url).then(arr=>{
      if(Array.isArray(arr)){ prefs.extended_catalog = arr; writePrefs(prefs); Noty('Список обновлён из '+url); }
      else Noty('Неверный формат JSON');
    }).catch(e=>Noty('Ошибка загрузки: '+e));
  }

  function registerSettings(){
    if(!Lampa || !Lampa.Settings) return;
    const section = {
      title: 'Dark Side',
      items: [
        {title:'Включить расширение', value:prefs.enabled?'Да':'Нет', onClick(){ prefs.enabled=!prefs.enabled; this.value=prefs.enabled?'Да':'Нет'; writePrefs(prefs);} },
        {title:'Импортировать список (JSON URL)', value:'Импорт', onClick(){ 
          const url = prompt('URL JSON', TEST_JSON_URL); if(url) importFromJSON(url); 
        }},
        {title:'Быстрый импорт тестового списка', subtitle:'Загружает тестовый список расширенных источников', value:'Импорт', onClick(){ importFromJSON(TEST_JSON_URL); }},
        {separator:true, title:'Расширенные источники (⚠️)'},
        {title:'Включить расширенные источники', value:prefs.extended_enabled?'Да':'Нет', onClick(){ prefs.extended_enabled=!prefs.extended_enabled; this.value=prefs.extended_enabled?'Да':'Нет'; writePrefs(prefs);} }
      ]
    };
    (prefs.extended_catalog||[]).forEach((item)=>{
      section.items.push({title:item.name, subtitle:item.desc, value:item.enabled?'Вкл':'Выкл', onClick(){
        if(!prefs.extended_enabled){ Noty('Сначала включите расширенные источники'); return; }
        if(!item.enabled && !item.url){ const u=prompt('URL адаптера для '+item.name, ''); if(!u) return; item.url=u; }
        item.enabled=!item.enabled; this.value=item.enabled?'Вкл':'Выкл'; writePrefs(prefs);
      }});
    });
    if(Lampa.Settings.add) Lampa.Settings.add(section);
  }

  function delayedInit(){
    if(!prefs.enabled) return;
    let tries = 0;
    const timer = setInterval(()=>{
      tries++;
      if(ensureMenuSource()){
        registerSettings();
        clearInterval(timer);
        log('Initialized after', tries, 'tries');
      }
      if(tries > 40){ // ~20 sec timeout
        clearInterval(timer);
        log('Initialization timeout');
      }
    }, 500);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', delayedInit);
  else delayedInit();

})();
