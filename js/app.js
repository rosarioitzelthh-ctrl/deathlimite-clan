// ============================================================================
// ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan - APP MÓVIL GLOBAL COMPLETA (V6)
// ============================================================================

const STORAGE_KEY_STATE = 'deathlimite_clan_state_v6';
const STORAGE_KEY_SESSION = 'deathlimite_clan_session_v6';
const STORAGE_KEY_DEVICE = 'deathlimite_clan_device_id_v6';
const STORAGE_KEY_NOTIF_FIRED = 'deathlimite_notif_fired_v6';
const STORAGE_KEY_SEEN_BROADCAST = 'deathlimite_seen_broadcast_id_v6';

class FFClanApp {
  constructor() {
    this.clientId = 'client-' + Math.random().toString(36).substring(2, 10);
    this.deviceId = this.getOrCreateDeviceId();
    this.state = this.getInitialFallbackState();
    this.session = this.loadSession();
    this.currentView = 'roster';
    this.rosterFilter = 'all';
    this.uploadedImageData = '';
    this.remoteApiBase = '';
    this.permanentAppUrl = 'https://rosarioitzelthh-ctrl.github.io/deathlimite-clan/';
    this.ghRawApiBase = 'https://api.github.com/repos/rosarioitzelthh-ctrl/deathlimite-clan/contents';
    this.cloudRelayUrl = 'https://ntfy.sh/deathlimite_clan_sync_v11';
    this.photoCache = {};
    this.rememberPhotosFromState(this.state);
    this.isSaving = false;
    this.lastLocalMutationAt = 0;
    this.serverInfo = { localIPs: [], port: 3000, urls: [], publicUrl: this.permanentAppUrl };
    this.deferredInstallPrompt = null;
    this.broadcastChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('deathlimite_sync_v6') : null;
  }

  getApiUrl(endpoint) {
    const base = (this.remoteApiBase || '').replace(/\/+$/, '');
    return `${base}${endpoint}`;
  }

  rememberPhotosFromState(stateObj) {
    if (!this.photoCache) this.photoCache = {};
    for (const p of (stateObj?.posts || [])) {
      if (p && p.id && p.imageData && p.imageData !== '__PHOTO_REF__' && p.imageData.startsWith('data:')) {
        this.photoCache[p.id] = p.imageData;
      }
    }
  }

  restorePhotosIntoState(stateObj) {
    if (!stateObj || !Array.isArray(stateObj.posts)) return stateObj;
    this.rememberPhotosFromState(this.state);
    stateObj.posts = stateObj.posts.map(p => {
      if (p.imageData === '__PHOTO_REF__' && this.photoCache[p.id]) {
        return { ...p, imageData: this.photoCache[p.id] };
      }
      return p;
    });
    this.rememberPhotosFromState(stateObj);
    return stateObj;
  }

  async encodeStateForCloud(stateObj) {
    this.rememberPhotosFromState(stateObj);
    const lite = {
      ...stateObj,
      posts: (stateObj.posts || []).map(p => ({
        ...p,
        imageData: p.imageData ? '__PHOTO_REF__' : ''
      }))
    };
    const jsonStr = JSON.stringify(lite);
    if (typeof CompressionStream !== 'undefined') {
      try {
        const bytes = new TextEncoder().encode(jsonStr);
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const buf = await new Response(cs.readable).arrayBuffer();
        const uint8 = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        return 'GZ:' + btoa(binary);
      } catch (e) {}
    }
    return jsonStr;
  }

  async decodeStateFromCloud(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return null;
    const trimmed = rawStr.trim();
    if (trimmed.startsWith('GZ:') && typeof DecompressionStream !== 'undefined') {
      try {
        const b64 = trimmed.slice(3);
        const binary = atob(b64);
        const uint8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          uint8[i] = binary.charCodeAt(i);
        }
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(uint8);
        writer.close();
        const text = await new Response(ds.readable).text();
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.members)) {
          return this.restorePhotosIntoState(parsed);
        }
      } catch (e) {}
    }
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && Array.isArray(parsed.members)) {
          return this.restorePhotosIntoState(parsed);
        }
      } catch (e) {}
    }
    return null;
  }

  async parseCloudRelayMessage(msg) {
    if (!msg || msg.event !== 'message') return null;
    try {
      if (typeof msg.message === 'string' && (msg.message.startsWith('GZ:') || msg.message.trim().startsWith('{'))) {
        const decoded = await this.decodeStateFromCloud(msg.message);
        if (decoded) return decoded;
      }
      if (msg.attachment && msg.attachment.url) {
        const attRes = await fetch(msg.attachment.url, { cache: 'no-store' });
        if (attRes.ok) {
          const rawText = await attRes.text();
          const decoded = await this.decodeStateFromCloud(rawText);
          if (decoded) return decoded;
        }
      }
    } catch (e) {}
    return null;
  }

  async fetchLatestFromCloudRelay(minVersion = 0) {
    try {
      const r = await fetch(`${this.cloudRelayUrl}/json?poll=1&since=12h`, { cache: 'no-store' });
      if (!r.ok) return null;
      const text = await r.text();
      const lines = text.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.event === 'message') {
            const msgVer = Number(msg.title) || 0;
            if (minVersion > 0 && msgVer > 0 && msgVer <= minVersion) {
              return null;
            }
            const state = await this.parseCloudRelayMessage(msg);
            if (state && Array.isArray(state.members)) {
              return state;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  async fetchUncachedCloudJson(filename) {
    // 1. Primero leer desde la API directa de GitHub (sin caché de 10 min de CDN)
    try {
      const r = await fetch(`${this.ghRawApiBase}/${filename}?ref=gh-pages&t=${Date.now()}`, {
        headers: { 'Accept': 'application/vnd.github.raw+json' },
        cache: 'no-store'
      });
      if (r.ok) {
        return await r.json();
      }
    } catch (e) {}

    // 2. Respaldo al archivo relativo
    try {
      const r2 = await fetch(`./${filename}?t=${Date.now()}`, { cache: 'no-store' });
      if (r2.ok) {
        return await r2.json();
      }
    } catch (e) {}
    return null;
  }

  async resolveLiveBackend() {
    this.serverInfo.publicUrl = this.permanentAppUrl;
    if (!window.location.hostname.includes('github.io')) {
      try {
        const r = await fetch('/api/info?t=' + Date.now(), { cache: 'no-store' });
        if (r.ok) {
          this.remoteApiBase = '';
          this.serverInfo = await r.json();
          this.serverInfo.publicUrl = this.permanentAppUrl;
          return true;
        }
      } catch (e) {}
    }
    return true;
  }

  getOrCreateDeviceId() {
    let id = localStorage.getItem(STORAGE_KEY_DEVICE);
    if (!id) {
      id = 'dev-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem(STORAGE_KEY_DEVICE, id);
    }
    return id;
  }

  getInitialFallbackState() {
    const cached = localStorage.getItem(STORAGE_KEY_STATE);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }
    const now = new Date().toISOString();
    return {
      version: 6,
      updatedAt: now,
      clanInfo: {
        name: '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan',
        tag: 'DL•',
        whatsappCommunity: '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan',
        whatsappGroupName: 'Integrantes',
        whatsappGroupLink: '',
        minPlacasGuerra: 80,
        credentials: {
          adminUser: 'admin',
          adminPass: 'admin123'
        },
        warNotifConfig: {
          msg1pm: '¡Alístense todos en ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄! Hoy es día de Guerra de Clanes. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! 😂🔥',
          msg6pm: '🚨 ¡YA EMPEZÓ LA GUERRA DE CLANES! Todos a jugar ya. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! ⚔️🏅 El que no haga placas suma falta.'
        },
        lastBroadcastNotification: null
      },
      members: [
        {
          id: 'm1',
          nick: 'DL•SombraFF',
          previousNick: '',
          ffId: '2948104921',
          password: '123',
          role: 'Líder',
          gameRole: '👑 IGL / Capitán',
          avatarColor: '#ff4500',
          readyForWar: true,
          placas: 420,
          honor: 4150,
          faltasBase: 0,
          semanasMas3kPrevias: 3,
          updatedAt: now
        },
        {
          id: 'm2',
          nick: 'DL•Valkiria',
          previousNick: '',
          ffId: '5839201844',
          password: '123',
          role: 'Decano',
          gameRole: '🔥 Rusher',
          avatarColor: '#ec4899',
          readyForWar: true,
          placas: 380,
          honor: 3620,
          faltasBase: 1,
          semanasMas3kPrevias: 1,
          updatedAt: now
        },
        {
          id: 'm3',
          nick: 'DL•Ghost99',
          previousNick: '',
          ffId: '7492018392',
          password: '123',
          role: 'Integrante',
          gameRole: '🎯 Francotirador',
          avatarColor: '#3b82f6',
          readyForWar: false,
          placas: 210,
          honor: 2450,
          faltasBase: 0,
          semanasMas3kPrevias: 0,
          updatedAt: now
        },
        {
          id: 'm4',
          nick: 'DL•DrakoYT',
          previousNick: '',
          ffId: '9102938475',
          password: '123',
          role: 'Integrante',
          gameRole: '💣 Granadero',
          avatarColor: '#eab308',
          readyForWar: false,
          placas: 30,
          honor: 2100,
          faltasBase: 1,
          semanasMas3kPrevias: 0,
          updatedAt: now
        },
        {
          id: 'm5',
          nick: 'DL•Kratos07',
          previousNick: '',
          ffId: '3849201928',
          password: '123',
          role: 'Integrante',
          gameRole: '🛡️ Soporte',
          avatarColor: '#ef4444',
          readyForWar: false,
          placas: 0,
          honor: 1950,
          faltasBase: 2,
          semanasMas3kPrevias: 0,
          updatedAt: now
        },
        {
          id: 'm6',
          nick: 'DL•ZeroKill',
          previousNick: '',
          ffId: '6673829104',
          password: '123',
          role: 'Integrante',
          gameRole: '🔥 Rusher',
          avatarColor: '#a855f7',
          readyForWar: false,
          placas: 110,
          honor: 1120,
          faltasBase: 0,
          semanasMas3kPrevias: 0,
          updatedAt: now
        }
      ],
      expelledHistory: [],
      posts: [],
      complaints: []
    };
  }

  async init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'LOCAL_STATE_UPDATE' && ev.data.clientId !== this.clientId) {
          this.handleIncomingState(ev.data.state);
        }
      };
    }

    window.addEventListener('storage', (ev) => {
      if (ev.key === STORAGE_KEY_STATE && ev.newValue) {
        try {
          this.handleIncomingState(JSON.parse(ev.newValue));
        } catch (e) {}
      }
    });

    await this.resolveLiveBackend();
    await this.fetchServerState();
    this.connectRealtimeStream();
    this.startFastPollingForMobile();
    this.startScheduledWarNotificationsClock();

    this.setupAuthScreen();
    this.renderAll();
  }

  isUserEditingOrModalOpen() {
    const modals = ['memberModal', 'newPostModal', 'storyModal', 'syncModal', 'ocrHonorModal'];
    for (const id of modals) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) return true;
    }
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      if (active.id !== 'loginIdentifier' && active.id !== 'loginPassword') {
        return true;
      }
    }
    return false;
  }

  // Polling de respaldo cada 14s en la nube (además del stream SSE instantáneo)
  startFastPollingForMobile() {
    const pollNow = async () => {
      if (this.isSaving || (Date.now() - this.lastLocalMutationAt < 5000)) {
        return;
      }
      try {
        const localVer = Number(this.state.version) || 0;
        const relayState = await this.fetchLatestFromCloudRelay(localVer);
        if (relayState && !this.isSaving && (Date.now() - this.lastLocalMutationAt >= 5000)) {
          const remoteVer = Number(relayState.version) || 0;
          const remoteNotifId = relayState.clanInfo?.lastBroadcastNotification?.id;
          const seenNotifId = localStorage.getItem(STORAGE_KEY_SEEN_BROADCAST);
          if (remoteVer > localVer || (remoteNotifId && remoteNotifId !== seenNotifId)) {
            this.handleIncomingState(relayState);
          }
          this.setSyncStatus(true, 'En línea');
        }
      } catch (e) {}
    };

    setInterval(pollNow, 14000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollNow();
      }
    });
  }

  checkAndTriggerUnreadNotification(stateObj) {
    const notif = stateObj?.clanInfo?.lastBroadcastNotification;
    if (!notif || !notif.id) return;

    const seenId = localStorage.getItem(STORAGE_KEY_SEEN_BROADCAST);
    if (seenId === notif.id) return;

    // Mostrar si fue enviada en las últimas 6 horas
    const ageMs = Date.now() - new Date(notif.sentAt || 0).getTime();
    if (ageMs < 6 * 3600 * 1000) {
      localStorage.setItem(STORAGE_KEY_SEEN_BROADCAST, notif.id);
      this.deliverWarNotificationToDevice(notif.title, notif.body);
    } else {
      localStorage.setItem(STORAGE_KEY_SEEN_BROADCAST, notif.id);
    }
  }

  handleIncomingState(newState) {
    if (!newState) return;
    this.state = newState;
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(this.state));
    this.checkAndTriggerUnreadNotification(newState);
    this.syncSessionNickIfChanged();
    if (!this.isUserEditingOrModalOpen()) {
      this.renderAll();
    }
  }

  syncSessionNickIfChanged() {
    if (!this.session || this.isAdmin()) return;
    const m = this.getMyMemberObject();
    if (m && m.nick !== this.session.nick) {
      this.session.nick = m.nick;
      this.saveSession(this.session);
    }
  }

  getMyMemberObject() {
    if (!this.session || this.isAdmin()) return null;
    const members = this.state.members || [];
    return members.find(
      m =>
        (this.session.memberId && m.id === this.session.memberId) ||
        (this.session.ffId && m.ffId === this.session.ffId) ||
        (this.session.nick && m.nick.toLowerCase() === this.session.nick.toLowerCase())
    );
  }

  async refreshServerInfoOnly() {
    try {
      await this.resolveLiveBackend();
      const infoRes = await fetch(this.getApiUrl('/api/info?t=' + Date.now()), { cache: 'no-store' });
      if (infoRes.ok) {
        this.serverInfo = await infoRes.json();
        if (this.currentView === 'profile') {
          this.renderProfileView();
        }
      }
    } catch (e) {}
  }

  async fetchServerState() {
    try {
      const candidates = [];
      let relayVer = 0;

      // 1. Primero cargar respaldo permanente de GitHub para tener todas las fotos en caché
      const ghPromise = this.fetchUncachedCloudJson('clan-state.json').then(s => {
        if (s && s.members) {
          this.rememberPhotosFromState(s);
          candidates.push(s);
        }
      }).catch(() => {});

      await ghPromise;

      // 2. Nube en tiempo real (ntfy.sh)
      try {
        const s = await this.fetchLatestFromCloudRelay(0);
        if (s && s.members) {
          relayVer = Number(s.version) || 0;
          candidates.push(this.restorePhotosIntoState(s));
        }
      } catch (e) {}

      if (candidates.length > 0) {
        candidates.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
        const newest = this.restorePhotosIntoState(candidates[0]);
        if ((Number(newest.version) || 0) >= (Number(this.state.version) || 0) || (this.state.version || 0) <= 10) {
          this.state = newest;
          localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(this.state));
        }
        // Si el estado local/GitHub es más nuevo que el bus en vivo (ej. tras 12h sin uso), re-publicar al bus
        if ((Number(this.state.version) || 0) > relayVer) {
          this.encodeStateForCloud(this.state).then(encoded => {
            fetch(this.cloudRelayUrl, {
              method: 'POST',
              headers: { 'Title': String(this.state.version) },
              body: encoded
            }).catch(() => {});
          });
        }
        this.setSyncStatus(true, 'En línea');
        if (this.session) {
          this.checkAndTriggerUnreadNotification(this.state);
        }
        return;
      }
    } catch (e) {}
    this.setSyncStatus(true, 'En línea');
  }

  connectRealtimeStream() {
    if (this.cloudEventSource) {
      try { this.cloudEventSource.close(); } catch (e) {}
    }
    try {
      // Stream SSE mundial en tiempo real (funciona 24/7 en todos los celulares y operadoras)
      this.cloudEventSource = new EventSource(`${this.cloudRelayUrl}/sse`);
      this.cloudEventSource.onopen = () => {
        this.setSyncStatus(true, 'En línea');
      };
      this.cloudEventSource.onmessage = async (event) => {
        try {
          if (this.isSaving || (Date.now() - this.lastLocalMutationAt < 3500)) return;
          const msg = JSON.parse(event.data);
          if (msg && msg.event === 'message') {
            const msgVer = Number(msg.title) || 0;
            const localVer = Number(this.state.version) || 0;
            if (msgVer === 0 || msgVer > localVer) {
              const newState = await this.parseCloudRelayMessage(msg);
              if (newState && !this.isSaving && (Date.now() - this.lastLocalMutationAt >= 3500)) {
                if ((Number(newState.version) || 0) > (Number(this.state.version) || 0)) {
                  this.handleIncomingState(newState);
                }
              }
            }
          }
        } catch (err) {}
      };
    } catch (err) {}

    if (!window.location.hostname.includes('github.io')) {
      if (this.eventSource) {
        try { this.eventSource.close(); } catch (e) {}
      }
      try {
        this.eventSource = new EventSource('/api/stream');
        this.eventSource.onmessage = (event) => {
          try {
            if (this.isSaving || (Date.now() - this.lastLocalMutationAt < 3500)) return;
            const payload = JSON.parse(event.data);
            if (payload && payload.state && payload.originClientId !== this.clientId) {
              if ((Number(payload.state.version) || 0) > (Number(this.state.version) || 0)) {
                this.handleIncomingState(payload.state);
              }
            }
          } catch (err) {}
        };
      } catch (err) {}
    }
  }

  async persistAndSync(toastMsg = null) {
    this.isSaving = true;
    this.lastLocalMutationAt = Date.now();
    this.state.updatedAt = new Date().toISOString();
    this.state.version = (Number(this.state.version) || 1) + 1;
    this.rememberPhotosFromState(this.state);
    const stateJson = JSON.stringify(this.state);
    localStorage.setItem(STORAGE_KEY_STATE, stateJson);

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'LOCAL_STATE_UPDATE',
        clientId: this.clientId,
        state: this.state
      });
    }

    this.renderAll();
    if (toastMsg) this.showToast(toastMsg);

    try {
      const encodedPayload = await this.encodeStateForCloud(this.state);
      const res = await fetch(this.cloudRelayUrl, {
        method: 'POST',
        headers: { 'Title': String(this.state.version) },
        body: encodedPayload
      });
      if (!res.ok) throw new Error('Cloud POST failed');
      this.lastLocalMutationAt = Date.now();
      this.setSyncStatus(true, 'En línea');
    } catch (e) {
      this.setSyncStatus(true, 'Guardado');
    } finally {
      this.isSaving = false;
    }
  }

  setSyncStatus(online, text) {
    const dot = document.getElementById('syncIndicatorDot');
    const label = document.getElementById('syncIndicatorText');
    if (dot) dot.className = online ? 'sync-dot' : 'sync-dot offline';
    if (label) label.textContent = text;
  }

  // ============================================================================
  // RELOJ DE NOTIFICACIONES DE GUERRA: MIÉRCOLES, SÁBADOS Y DOMINGOS (1 PM Y 6 PM)
  // ============================================================================
  startScheduledWarNotificationsClock() {
    const checkSchedule = () => {
      const now = new Date();
      const day = now.getDay(); // 0 = Domingo, 3 = Miércoles, 6 = Sábado
      const isWarDay = day === 3 || day === 6 || day === 0;
      if (!isWarDay) return;

      const hours = now.getHours();
      const minutes = now.getMinutes();
      const dateKey = now.toISOString().slice(0, 10);
      const firedMap = JSON.parse(localStorage.getItem(STORAGE_KEY_NOTIF_FIRED) || '{}');

      const cfg = this.state.clanInfo?.warNotifConfig || {};
      const msg1pm = cfg.msg1pm || '¡Alístense todos en ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄! Hoy es día de Guerra de Clanes. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! 😂🔥';
      const msg6pm = cfg.msg6pm || '🚨 ¡YA EMPEZÓ LA GUERRA DE CLANES! Todos a jugar ya. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! ⚔️🏅';

      // 1:00 PM (13:00 a 13:10)
      if (hours === 13 && minutes <= 10 && !firedMap[`${dateKey}_1pm`]) {
        firedMap[`${dateKey}_1pm`] = true;
        localStorage.setItem(STORAGE_KEY_NOTIF_FIRED, JSON.stringify(firedMap));
        this.deliverWarNotificationToDevice('⚔️ ¡HOY ES GUERRA DE CLANES! (1:00 PM)', msg1pm);
      }

      // 6:00 PM (18:00 a 18:10)
      if (hours === 18 && minutes <= 10 && !firedMap[`${dateKey}_6pm`]) {
        firedMap[`${dateKey}_6pm`] = true;
        localStorage.setItem(STORAGE_KEY_NOTIF_FIRED, JSON.stringify(firedMap));
        this.deliverWarNotificationToDevice('🚨 ¡YA EMPEZÓ LA GUERRA DE CLANES! (6:00 PM)', msg6pm);
      }
    };

    checkSchedule();
    setInterval(checkSchedule, 20000);
  }

  async requestNotificationPermission() {
    if (!('Notification' in window)) {
      this.deliverWarNotificationToDevice(
        '🔔 Alertas Activadas — ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄',
        'Recuerda que si quieres más placas en Guerra de Clanes, debes jugar con los del clan, ¡aunque te caigan mal! 😂🔥'
      );
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        this.showToast('🔔 ¡Notificaciones activadas en tu celular!');
        this.deliverWarNotificationToDevice(
          '🔔 Notificaciones Activadas — ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄',
          'Recuerda que si quieres más placas en Guerra de Clanes, debes jugar con los del clan, ¡aunque te caigan mal! 😂🔥'
        );
        this.renderRoster();
        this.renderProfileView();
      } else {
        this.deliverWarNotificationToDevice(
          '⚔️ Aviso del Clan — ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄',
          'Recuerda que si quieres más placas en Guerra de Clanes, debes jugar con los del clan, ¡aunque te caigan mal! 😂🔥'
        );
      }
    } catch (e) {
      this.deliverWarNotificationToDevice(
        '⚔️ Aviso del Clan — ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄',
        'Recuerda que si quieres más placas en Guerra de Clanes, debes jugar con los del clan, ¡aunque te caigan mal! 😂🔥'
      );
    }
  }

  sendLiveWarNotification(type) {
    if (!this.isAdmin()) return;
    const cfg = this.state.clanInfo?.warNotifConfig || {};
    const msg1pm = cfg.msg1pm || '¡Alístense todos en ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄! Hoy es día de Guerra de Clanes. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! 😂🔥';
    const msg6pm = cfg.msg6pm || '🚨 ¡YA EMPEZÓ LA GUERRA DE CLANES! Todos a jugar ya. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! ⚔️🏅';

    const title = type === '1pm'
      ? '⚔️ ¡ALÍSTENSE PARA LA GUERRA DE CLANES! (1:00 PM)'
      : '🚨 ¡YA EMPEZÓ LA GUERRA DE CLANES! (6:00 PM)';
    const body = type === '1pm' ? msg1pm : msg6pm;

    if (!this.state.clanInfo) this.state.clanInfo = {};
    const notifObj = {
      id: 'notif-' + Date.now(),
      title,
      body,
      sentAt: new Date().toISOString()
    };
    localStorage.setItem(STORAGE_KEY_SEEN_BROADCAST, notifObj.id);
    this.state.clanInfo.lastBroadcastNotification = notifObj;

    this.deliverWarNotificationToDevice(title, body);
    this.persistAndSync('📢 ¡Notificación enviada a todos los integrantes!');
  }

  deliverWarNotificationToDevice(title, body) {
    // 1. Vibración intensa en celulares Android
    try {
      if (navigator.vibrate) {
        navigator.vibrate([300, 140, 300, 140, 450]);
      }
    } catch (e) {}

    // 2. Sonido de alerta gamer
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.18, ctx.currentTime + idx * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.24);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + idx * 0.12);
          osc.stop(ctx.currentTime + idx * 0.12 + 0.25);
        });
      }
    } catch (e) {}

    // 3. Notificación nativa en la barra superior de Android / Navegador
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistration().then(reg => {
            if (reg && reg.showNotification) {
              reg.showNotification(title, {
                body,
                icon: './icons/icon.svg',
                badge: './icons/icon.svg',
                vibrate: [300, 140, 300],
                requireInteraction: true
              });
            } else {
              new Notification(title, { body, icon: './icons/icon.svg' });
            }
          }).catch(() => {
            new Notification(title, { body, icon: './icons/icon.svg' });
          });
        } else {
          new Notification(title, { body, icon: './icons/icon.svg' });
        }
      }
    } catch (e) {}

    // 4. Alerta emergente grande en la pantalla del integrante (100% visible siempre)
    const popupBox = document.getElementById('warPushPopupContainer');
    if (popupBox) {
      popupBox.innerHTML = `
        <div class="war-push-popup">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
            <div>
              <div style="font-size:0.75rem; font-weight:900; color:#fbbf24; text-transform:uppercase;">
                🔔 AVISO DE GUERRA • ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan
              </div>
              <div style="font-size:1.08rem; font-weight:900; color:#fff; margin:5px 0 6px;">
                ${this.escapeHtml(title)}
              </div>
              <div style="font-size:0.9rem; color:#f8fafc; line-height:1.45; margin-bottom:12px;">
                ${this.escapeHtml(body)}
              </div>
            </div>
            <button type="button" class="close-btn" onclick="document.getElementById('warPushPopupContainer').innerHTML=''">✕</button>
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn-success btn-sm btn-block" onclick="app.acknowledgeWarAlert()">
              ✅ ¡Enterado! Marcarme Activo para Guerra
            </button>
          </div>
        </div>
      `;
    }
  }

  acknowledgeWarAlert() {
    const popupBox = document.getElementById('warPushPopupContainer');
    if (popupBox) popupBox.innerHTML = '';
    const m = this.getMyMemberObject();
    if (m && !m.readyForWar) {
      m.readyForWar = true;
      this.persistAndSync('🟢 ¡Listo! Apareces como ACTIVO para jugar Guerra con el Clan');
    } else {
      this.showToast('⚔️ ¡A darle con todo por las placas del clan!');
    }
  }

  // ============================================================================
  // REGLAS AUTOMÁTICAS: POR PLACAS DE GUERRA DE CLANES, HONOR Y FALTAS
  // ============================================================================
  getMinPlacasGuerra() {
    return Math.max(1, Number(this.state.clanInfo?.minPlacasGuerra) || 80);
  }

  getMinHonorKeep() {
    const raw = this.state.clanInfo?.minHonorKeep ?? this.state.clanInfo?.rules?.minHonorKeep;
    const val = Number(raw);
    return Number.isFinite(val) && val >= 0 ? val : 1500;
  }

  getHonorClearThreshold() {
    const raw = this.state.clanInfo?.honorClearThreshold ?? this.state.clanInfo?.rules?.honorClearThreshold;
    const val = Number(raw);
    return Number.isFinite(val) && val >= 1 ? val : 3000;
  }

  openLimitsSettings() {
    if (!this.isAdmin()) return;
    this.switchView('profile');
    setTimeout(() => {
      const el = document.getElementById('adminSettingsCard');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  evaluateMember(m) {
    const minPlacasGuerra = this.getMinPlacasGuerra();
    const minHonorKeep = this.getMinHonorKeep();
    const honorClearThreshold = this.getHonorClearThreshold();
    const honor = Number(m.honor) || 0;
    const placas = Number(m.placas) || 0;
    const faltasBase = Math.max(0, Number(m.faltasBase) || 0);
    const semanasPrevias3k = Math.max(0, Number(m.semanasMas3kPrevias) || 0);

    // 1. ¿Cumplió las Placas de Guerra de Clanes?
    const cumplioGuerra = placas >= minPlacasGuerra;
    const faltaPorGuerraActual = cumplioGuerra ? 0 : 1;
    const faltasBrutas = faltasBase + faltaPorGuerraActual;

    // 2. Para quitar las faltas deben hacer mínimo 2 semanas de más del límite de honor para limpiar
    const semanaActualMas3k = honor > honorClearThreshold ? 1 : 0;
    const semanasTotalesMas3k = semanasPrevias3k + semanaActualMas3k;
    const limpiaFaltasPorHonor = semanasTotalesMas3k >= 2 && faltasBrutas > 0;
    const faltasEfectivas = limpiaFaltasPorHonor ? 0 : faltasBrutas;

    // 3. Expulsiones: < minHonorKeep honor O 3 faltas
    const expulsadoPorHonorBajo = honor < minHonorKeep;
    const expulsadoPorTresFaltas = faltasEfectivas >= 3;
    const seVaExpulsado = expulsadoPorHonorBajo || expulsadoPorTresFaltas;
    const vaBien = !seVaExpulsado && faltasEfectivas === 0;

    const razonesExpulsion = [];
    if (expulsadoPorHonorBajo) {
      razonesExpulsion.push(`Honor menor a ${minHonorKeep.toLocaleString()} (${honor.toLocaleString()})`);
    }
    if (expulsadoPorTresFaltas) {
      razonesExpulsion.push(`Acumuló ${faltasEfectivas}/3 Faltas (${placas} placas de Guerra)`);
    }

    let badgeType = 'ok';
    let badgeText = '✅ Va bien';
    if (seVaExpulsado) {
      badgeType = 'expelled';
      badgeText = '💀 Expulsado';
    } else if (faltasEfectivas > 0) {
      badgeType = 'warning';
      badgeText = `⚠️ ${faltasEfectivas}/3 Faltas`;
    }

    return {
      minPlacasGuerra,
      minHonorKeep,
      honorClearThreshold,
      honor,
      placas,
      faltasBase,
      semanasPrevias3k,
      cumplioGuerra,
      faltasBrutas,
      semanasTotalesMas3k,
      limpiaFaltasPorHonor,
      faltasEfectivas,
      seVaExpulsado,
      vaBien,
      razonesExpulsion,
      badgeType,
      badgeText
    };
  }

  // ============================================================================
  // INICIO DE SESIÓN Y REGISTRO ESTILO FACEBOOK
  // ============================================================================
  loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  saveSession(session) {
    this.session = session;
    if (session) {
      localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(session));
    } else {
      localStorage.removeItem(STORAGE_KEY_SESSION);
    }
  }

  isAdmin() {
    return this.session && this.session.role === 'admin';
  }

  setupAuthScreen() {
    const authScreen = document.getElementById('authScreen');
    if (this.session) {
      authScreen.classList.add('hidden');
    } else {
      authScreen.classList.remove('hidden');
      this.showAuthMode('login');
    }
  }

  showAuthMode(mode) {
    const loginBox = document.getElementById('fbLoginBox');
    const regBox = document.getElementById('fbRegisterBox');
    if (mode === 'register') {
      loginBox.classList.add('hidden');
      regBox.classList.remove('hidden');
    } else {
      regBox.classList.add('hidden');
      loginBox.classList.remove('hidden');
    }
  }

  handleLogin(e) {
    e.preventDefault();
    const identifier = document.getElementById('loginIdentifier').value.trim();
    const pass = document.getElementById('loginPassword').value.trim();
    if (!identifier || !pass) return;

    const creds = this.state.clanInfo?.credentials || {
      adminUser: 'admin',
      adminPass: 'admin123'
    };

    if (identifier.toLowerCase() === creds.adminUser.toLowerCase() && pass === creds.adminPass) {
      this.saveSession({
        role: 'admin',
        nick: 'Administrador',
        ffId: 'admin',
        loginAt: new Date().toISOString()
      });
      document.getElementById('loginIdentifier').value = '';
      document.getElementById('loginPassword').value = '';
      document.getElementById('authScreen').classList.add('hidden');
      this.renderAll();
      this.showToast('👑 Bienvenido Administrador');
      return;
    }

    const member = (this.state.members || []).find(
      m =>
        (m.ffId && m.ffId.toLowerCase() === identifier.toLowerCase()) ||
        (m.nick && m.nick.toLowerCase() === identifier.toLowerCase())
    );

    if (!member) {
      this.showToast('❌ No encontramos ese ID o Nick. Si eres nuevo toca "Regístrate"');
      return;
    }

    const memberPass = member.password || '123';
    if (pass !== memberPass && pass !== creds.adminPass) {
      this.showToast('❌ Contraseña incorrecta');
      return;
    }

    this.saveSession({
      role: 'member',
      nick: member.nick,
      ffId: member.ffId,
      memberId: member.id,
      loginAt: new Date().toISOString()
    });
    document.getElementById('loginIdentifier').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('authScreen').classList.add('hidden');

    // Pedir permiso de notificaciones al iniciar sesión y verificar si hay aviso pendiente
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    this.checkAndTriggerUnreadNotification(this.state);

    this.renderAll();
    this.showToast(`🎮 Hola, ${member.nick}`);
  }

  async handleRegister(e) {
    e.preventDefault();
    const nick = document.getElementById('regNick').value.trim();
    const ffId = document.getElementById('regFfId').value.trim();
    const password = document.getElementById('regPassword').value.trim();

    if (!nick || !ffId || !password) {
      this.showToast('⚠️ Completa todos los campos');
      return;
    }

    const existing = (this.state.members || []).find(
      m => m.ffId === ffId || m.nick.toLowerCase() === nick.toLowerCase()
    );

    if (existing) {
      this.showToast('⚠️ Ese ID o Nick ya existe. Inicia sesión.');
      this.showAuthMode('login');
      document.getElementById('loginIdentifier').value = ffId;
      return;
    }

    const colors = ['#ff4500', '#ec4899', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6', '#06b6d4'];
    const newMember = {
      id: 'm-' + Date.now(),
      nick,
      previousNick: '',
      ffId,
      password,
      role: 'Integrante',
      gameRole: '🔥 Rusher',
      avatarColor: colors[(this.state.members || []).length % colors.length],
      readyForWar: true,
      placas: 80,
      honor: 1500,
      faltasBase: 0,
      semanasMas3kPrevias: 0,
      updatedAt: new Date().toISOString()
    };

    if (!this.state.members) this.state.members = [];
    this.state.members.unshift(newMember);

    this.saveSession({
      role: 'member',
      nick: newMember.nick,
      ffId: newMember.ffId,
      memberId: newMember.id,
      loginAt: new Date().toISOString()
    });

    document.getElementById('regNick').value = '';
    document.getElementById('regFfId').value = '';
    document.getElementById('regPassword').value = '';
    document.getElementById('authScreen').classList.add('hidden');

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    await this.persistAndSync(`✅ ¡Bienvenido a ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄, ${nick}!`);
  }

  logout() {
    this.saveSession(null);
    this.setupAuthScreen();
  }

  // ============================================================================
  // NAVEGACIÓN Y RENDERIZADO
  // ============================================================================
  switchView(viewName) {
    this.currentView = viewName;
    const views = ['roster', 'expulsions', 'clangram', 'complaints', 'profile'];
    views.forEach(v => {
      document.getElementById(`view-${v}`)?.classList.toggle('hidden', v !== viewName);
      document.getElementById(`nav-${v}`)?.classList.toggle('active', v === viewName);
    });
    this.renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderAll() {
    const clanName = this.state.clanInfo?.name || '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan';
    const headerTitle = document.getElementById('headerClanName');
    const authTitle = document.getElementById('authClanTitle');
    if (headerTitle) headerTitle.textContent = clanName;
    if (authTitle) authTitle.textContent = clanName;

    const adminTopBar = document.getElementById('adminTopBar');
    if (adminTopBar) {
      adminTopBar.classList.toggle('hidden', !this.isAdmin());
    }

    const navProfileLabel = document.getElementById('navProfileLabel');
    if (navProfileLabel) {
      navProfileLabel.textContent = this.isAdmin() ? 'Admin / Perfil' : 'Mi Perfil';
    }

    this.updateNavBadges();
    this.renderRoster();
    this.renderExpulsionsView();
    this.renderClanGram();
    this.renderComplaintsView();
    this.renderProfileView();
  }

  updateNavBadges() {
    const members = this.state.members || [];
    const withProblems = members.filter(m => {
      const ev = this.evaluateMember(m);
      return ev.seVaExpulsado || ev.faltasEfectivas > 0;
    }).length;
    const badgeExp = document.getElementById('badgeExpulsions');
    if (badgeExp) {
      badgeExp.textContent = withProblems;
      badgeExp.classList.toggle('hidden', withProblems === 0);
    }

    const pendingComplaints = (this.state.complaints || []).filter(c => c.status !== 'Resuelta').length;
    const badgeComp = document.getElementById('badgeComplaints');
    if (badgeComp) {
      badgeComp.textContent = pendingComplaints;
      badgeComp.classList.toggle('hidden', pendingComplaints === 0 || !this.isAdmin());
    }
  }

  // ============================================================================
  // VISTA 1: INICIO (NOTIFICACIONES, MI PERFIL RÁPIDO, PODIO TOP 3 Y LISTA)
  // ============================================================================
  setRosterFilter(filter) {
    this.rosterFilter = filter;
    const buttons = document.querySelectorAll('#rosterFilterPills .filter-btn');
    const map = ['all', 'good', 'faults', 'expelled', 'ready'];
    buttons.forEach((btn, idx) => {
      btn.classList.toggle('active', map[idx] === filter);
    });
    this.renderRoster();
  }

  toggleMyReadyForWar() {
    const m = this.getMyMemberObject();
    if (!m) return;
    m.readyForWar = !m.readyForWar;
    this.persistAndSync(
      m.readyForWar
        ? '🟢 ¡Marcado como ACTIVO buscando escuadra del clan para Guerra!'
        : '⚪ Estado de escuadra desactivado'
    );
  }

  renderRoster() {
    const members = this.state.members || [];
    const evaluated = members.map(m => ({ member: m, eval: this.evaluateMember(m) }));

    // 0. BANNER DE NOTIFICACIONES AUTOMÁTICAS (SIEMPRE VISIBLE SI NO HAN DADO PERMISO)
    const notifBanner = document.getElementById('warNotifStatusBanner');
    if (notifBanner) {
      const hasPerm = 'Notification' in window && Notification.permission === 'granted';
      if (!hasPerm) {
        notifBanner.innerHTML = `
          <div class="war-alert-banner">
            <div>
              <div style="font-size:0.82rem; font-weight:900; color:#fbbf24;">🔔 Activa los Avisos de Guerra de Clanes</div>
              <div style="font-size:0.74rem; color:#e2e8f0; margin-top:2px;">
                Toca el botón para recibir las notificaciones los <strong>Miércoles, Sábados y Domingos (1:00 PM y 6:00 PM)</strong>.
              </div>
            </div>
            <button type="button" class="btn btn-fire btn-sm" onclick="app.requestNotificationPermission()">
              🔔 Activar Avisos
            </button>
          </div>
        `;
      } else {
        notifBanner.innerHTML = '';
      }
    }

    // 1. TARJETA DE MI ESTADO PERSONAL
    const personalBox = document.getElementById('myPersonalStatusBox');
    if (personalBox) {
      if (this.session && !this.isAdmin()) {
        const myMember = this.getMyMemberObject();
        if (myMember) {
          const ev = this.evaluateMember(myMember);
          const cardClass = ev.seVaExpulsado ? 'bad' : ev.faltasEfectivas > 0 ? 'warn' : 'good';
          const statusTitle = ev.seVaExpulsado
            ? '💀 Estás en lista de expulsión'
            : ev.faltasEfectivas > 0
              ? `⚠️ Tienes ${ev.faltasEfectivas} de 3 faltas`
              : '✅ ¡Vas muy bien! (Sin faltas)';

          const statusDesc = ev.seVaExpulsado
            ? ev.razonesExpulsion.join(' • ')
            : ev.faltasEfectivas > 0
              ? `Para quitarte las faltas haz 2 semanas de >${ev.honorClearThreshold.toLocaleString()} de honor (llevas ${ev.semanasTotalesMas3k}/2).`
              : 'Recuerda jugar Guerra con los del clan (aunque te caigan mal 😂) para sacar más placas.';

          personalBox.innerHTML = `
            <div class="my-hero-card ${cardClass}">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                <div>
                  <div style="font-size:0.75rem; color:var(--text-muted); font-weight:800;">
                    ${this.escapeHtml(myMember.nick)} • ${this.escapeHtml(myMember.gameRole || '🔥 Rusher')}
                  </div>
                  <div style="font-size:1.18rem; font-weight:900; margin-top:2px;">
                    ${statusTitle}
                  </div>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.switchView('profile')">
                  ✏️ Cambiar Nick / Clave
                </button>
              </div>

              <div class="three-pillars-grid">
                <div class="pillar-box">
                  <div class="pillar-label">🔥 Honor</div>
                  <div class="pillar-value" style="color:${ev.honor < ev.minHonorKeep ? '#ef4444' : '#fbbf24'};">
                    ${ev.honor.toLocaleString()}
                  </div>
                  <div class="pillar-sub">Mín: ${ev.minHonorKeep.toLocaleString()}</div>
                </div>

                <div class="pillar-box">
                  <div class="pillar-label">🏅 Placas Guerra</div>
                  <div class="pillar-value" style="color:#38bdf8;">
                    ${ev.placas.toLocaleString()}
                  </div>
                  <div class="pillar-sub">${ev.cumplioGuerra ? '✅ Cumplió' : `❌ Mín: ${ev.minPlacasGuerra}`}</div>
                </div>

                <div class="pillar-box">
                  <div class="pillar-label">🚫 Faltas</div>
                  <div class="pillar-value" style="color:${ev.faltasEfectivas >= 3 ? '#ef4444' : ev.faltasEfectivas > 0 ? '#fbbf24' : '#4ade80'};">
                    ${ev.faltasEfectivas}/3
                  </div>
                  <div class="pillar-sub">Sem &gt;${(ev.honorClearThreshold / 1000).toFixed(1).replace('.0', '')}k: ${ev.semanasTotalesMas3k}/2</div>
                </div>
              </div>

              <div style="font-size:0.78rem; color:#e2e8f0; margin-top:10px; text-align:center;">
                ${this.escapeHtml(statusDesc)}
              </div>

              <button type="button" class="btn ${myMember.readyForWar ? 'btn-success' : 'btn-secondary'} btn-block btn-sm" style="margin-top:10px;" onclick="app.toggleMyReadyForWar()">
                ${myMember.readyForWar ? '🟢 Estoy ACTIVO para jugar Guerra con el Clan (Toca para desactivar)' : '⚪ Avisar que estoy activo para jugar Guerra con el Clan'}
              </button>
            </div>
          `;
        } else {
          personalBox.innerHTML = '';
        }
      } else {
        personalBox.innerHTML = '';
      }
    }

    // 2. PODIO TOP 3 GUERREROS EN PLACAS DE GUERRA DE CLANES
    const podiumBox = document.getElementById('podiumContainer');
    if (podiumBox && members.length >= 3) {
      const topPlacas = [...members].sort((a, b) => (b.placas || 0) - (a.placas || 0)).slice(0, 3);
      podiumBox.innerHTML = `
        <div style="font-size:0.74rem; font-weight:900; color:var(--text-muted); text-transform:uppercase; margin-bottom:6px; letter-spacing:0.4px;">
          🏆 Top 3 Placas en Guerra de Clanes
        </div>
        <div class="podium-grid">
          <div class="podium-card gold">
            <div style="font-size:1.3rem;">🥇</div>
            <div style="font-size:0.8rem; font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(topPlacas[0].nick)}</div>
            <div style="font-size:0.9rem; font-weight:900; color:#fbbf24; margin-top:2px;">${(topPlacas[0].placas || 0)} 🏅</div>
          </div>
          <div class="podium-card silver">
            <div style="font-size:1.3rem;">🥈</div>
            <div style="font-size:0.8rem; font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(topPlacas[1].nick)}</div>
            <div style="font-size:0.9rem; font-weight:900; color:#cbd5e1; margin-top:2px;">${(topPlacas[1].placas || 0)} 🏅</div>
          </div>
          <div class="podium-card bronze">
            <div style="font-size:1.3rem;">🥉</div>
            <div style="font-size:0.8rem; font-weight:900; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(topPlacas[2].nick)}</div>
            <div style="font-size:0.9rem; font-weight:900; color:#f59e0b; margin-top:2px;">${(topPlacas[2].placas || 0)} 🏅</div>
          </div>
        </div>
      `;
    } else if (podiumBox) {
      podiumBox.innerHTML = '';
    }

    // 3. FILTRAR LISTA
    const query = (document.getElementById('rosterSearchInput')?.value || '').trim().toLowerCase();
    const normQuery = this.normalizeNickForMatch(query);
    const filtered = evaluated.filter(({ member, eval: ev }) => {
      if (query) {
        const matchNick = member.nick.toLowerCase().includes(query) || (normQuery && this.normalizeNickForMatch(member.nick).includes(normQuery));
        const matchPrev = (member.previousNick || '').toLowerCase().includes(query) || (normQuery && this.normalizeNickForMatch(member.previousNick).includes(normQuery));
        const matchId = (member.ffId || '').toLowerCase().includes(query);
        if (!matchNick && !matchPrev && !matchId) return false;
      }
      if (this.rosterFilter === 'good') return ev.vaBien;
      if (this.rosterFilter === 'faults') return ev.faltasEfectivas > 0 && !ev.seVaExpulsado;
      if (this.rosterFilter === 'expelled') return ev.seVaExpulsado;
      if (this.rosterFilter === 'ready') return Boolean(member.readyForWar);
      return true;
    });

    const grid = document.getElementById('membersGrid');
    if (!grid) return;

    const isAdmin = this.isAdmin();

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="member-card" style="text-align:center; padding:28px; color:var(--text-muted);">
          No hay integrantes en este filtro.
        </div>
      `;
    } else {
      grid.innerHTML = filtered.map(({ member: m, eval: ev }) => {
        const cardStatusClass = ev.seVaExpulsado
          ? 'status-expelled'
          : ev.faltasEfectivas > 0
            ? 'status-warning'
            : '';

        const initials = m.nick.replace(/^[^a-zA-Z0-9]+/, '').substring(0, 2).toUpperCase() || 'DL';

        let reasonHtml = '';
        if (ev.seVaExpulsado) {
          reasonHtml = `<div class="verdict-line bad">💀 <strong>Se va expulsado:</strong> ${this.escapeHtml(ev.razonesExpulsion.join(' • '))}</div>`;
        } else if (ev.limpiaFaltasPorHonor) {
          reasonHtml = `<div class="verdict-line">🧹 <strong>Faltas borradas:</strong> Cumplió ${ev.semanasTotalesMas3k} semanas con &gt;${ev.honorClearThreshold.toLocaleString()} de honor.</div>`;
        } else if (ev.faltasEfectivas > 0) {
          reasonHtml = `<div class="verdict-line warn">⚠️ ${!ev.cumplioGuerra ? `Hizo pocas placas en Guerra (${ev.placas} &lt; ${ev.minPlacasGuerra} = +1 falta).` : 'Tiene faltas acumuladas.'} Semanas &gt;${ev.honorClearThreshold.toLocaleString()} honor: ${ev.semanasTotalesMas3k}/2</div>`;
        }

        return `
          <div class="member-card ${cardStatusClass}">
            <div class="member-top">
              <div class="member-user">
                <div class="avatar-circle" style="background:${m.avatarColor || '#ff4500'};">
                  ${this.escapeHtml(initials)}
                  ${m.readyForWar ? `<span class="online-ready-dot" title="Activo para jugar Guerra"></span>` : ''}
                </div>
                <div style="min-width:0;">
                  <div class="member-nick">${this.escapeHtml(m.nick)}</div>
                  <div class="member-id">
                    ID: ${this.escapeHtml(m.ffId)}
                    ${m.previousNick ? ` • Antes: ${this.escapeHtml(m.previousNick)}` : ''}
                  </div>
                  <div>
                    <span class="role-chip">${this.escapeHtml(m.gameRole || '🔥 Rusher')}</span>
                    ${m.readyForWar ? `<span class="role-chip" style="background:rgba(34,197,94,0.18); color:#4ade80;">🟢 Activo Guerra</span>` : ''}
                  </div>
                </div>
              </div>
              <span class="status-badge ${ev.badgeType}">${ev.badgeText}</span>
            </div>

            <!-- LOS 3 PILARES: HONOR, PLACAS DE GUERRA, FALTAS -->
            <div class="three-pillars-grid">
              <!-- HONOR -->
              <div class="pillar-box">
                <div class="pillar-label">🔥 Honor</div>
                <div class="pillar-value" style="color:${ev.honor < ev.minHonorKeep ? '#ef4444' : '#fbbf24'};">
                  ${ev.honor.toLocaleString()}
                </div>
                <div class="pillar-sub">${ev.honor > ev.honorClearThreshold ? `🌟 +${ev.honorClearThreshold.toLocaleString()} Élite` : `Mín: ${ev.minHonorKeep.toLocaleString()}`}</div>
                ${isAdmin ? `
                  <div class="step-row">
                    <button type="button" class="step-btn" onclick="app.quickAdjust('${m.id}', 'honor', -250)">-</button>
                    <button type="button" class="step-btn" onclick="app.quickAdjust('${m.id}', 'honor', 250)">+</button>
                  </div>
                ` : ''}
              </div>

              <!-- PLACAS DE GUERRA DE CLANES -->
              <div class="pillar-box">
                <div class="pillar-label">🏅 Placas Guerra</div>
                <div class="pillar-value" style="color:${ev.cumplioGuerra ? '#38bdf8' : '#ef4444'};">
                  ${ev.placas.toLocaleString()}
                </div>
                <div class="pillar-sub">${ev.cumplioGuerra ? '✅ Sí hizo placas' : `❌ Mín ${ev.minPlacasGuerra}`}</div>
                ${isAdmin ? `
                  <div class="step-row">
                    <button type="button" class="step-btn" onclick="app.quickAdjust('${m.id}', 'placas', -25)">-</button>
                    <button type="button" class="step-btn" onclick="app.quickAdjust('${m.id}', 'placas', 25)">+</button>
                  </div>
                ` : ''}
              </div>

              <!-- FALTAS -->
              <div class="pillar-box">
                <div class="pillar-label">🚫 Faltas</div>
                <div class="pillar-value" style="color:${ev.faltasEfectivas >= 3 ? '#ef4444' : ev.faltasEfectivas > 0 ? '#fbbf24' : '#4ade80'};">
                  ${ev.faltasEfectivas}/3
                </div>
                <div class="pillar-sub">Sem &gt;${(ev.honorClearThreshold / 1000).toFixed(1).replace('.0', '')}k: ${ev.semanasTotalesMas3k}/2</div>
                ${isAdmin ? `
                  <div class="step-row">
                    <button type="button" class="step-btn" onclick="app.quickAdjust('${m.id}', 'faltasBase', -1)">-</button>
                    <button type="button" class="step-btn" onclick="app.quickAdjust('${m.id}', 'faltasBase', 1)">+</button>
                  </div>
                ` : ''}
              </div>
            </div>

            ${reasonHtml}

            <!-- BOTONES DE DECISIÓN DEL ADMIN: ACTUALIZAR ESTADO / PERDONAR / EXPULSAR / BORRAR DE LA APP -->
            ${isAdmin ? `
              <div class="admin-decision-bar">
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.openMemberModal('${m.id}')">
                  🔄 Actualizar Estado
                </button>
                ${ev.faltasEfectivas > 0 || ev.seVaExpulsado ? `
                  <button type="button" class="btn btn-success btn-sm" onclick="app.forgiveMemberFaults('${m.id}')">
                    ✅ Poner Al Día
                  </button>
                ` : ''}
                <button type="button" class="btn btn-danger btn-sm" onclick="app.executeExpulsion('${m.id}')">
                  💀 Expulsar
                </button>
                <button type="button" class="btn btn-secondary btn-sm" style="color:#f87171;" onclick="app.deleteMember('${m.id}')" title="Borrar completamente de la app">
                  🗑️ Borrar de la App
                </button>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }

    // 4. BOTÓN AL FINAL DE LA LISTA (EXCLUSIVO PARA ADMIN): REDIRECCIONAR FALTAS A WHATSAPP
    this.renderWhatsAppBottomBox(evaluated);
  }

  forgiveMemberFaults(memberId) {
    if (!this.isAdmin()) return;
    const m = this.state.members.find(x => x.id === memberId);
    if (!m) return;
    m.faltasBase = 0;
    const minPlacas = this.getMinPlacasGuerra();
    const minHonor = this.getMinHonorKeep();
    if ((Number(m.placas) || 0) < minPlacas) {
      m.placas = minPlacas;
    }
    if ((Number(m.honor) || 0) < minHonor) {
      m.honor = minHonor;
    }
    m.updatedAt = new Date().toISOString();
    this.persistAndSync(`✅ Estado de ${m.nick} actualizado y puesto al día (0 faltas)`);
  }

  executeExpulsion(memberId) {
    if (!this.isAdmin()) return;
    const m = this.state.members.find(x => x.id === memberId);
    if (!m) return;
    const ev = this.evaluateMember(m);
    const reason = ev.razonesExpulsion.length
      ? ev.razonesExpulsion.join(' + ')
      : `Expulsado por Administración (${ev.placas} placas, ${ev.honor} honor)`;

    if (!confirm(`¿Expulsar a ${m.nick} del clan?\nPasará al historial de expulsados.`)) return;

    if (!this.state.expelledHistory) this.state.expelledHistory = [];
    this.state.expelledHistory.unshift({
      id: 'exp-' + Date.now(),
      nick: m.nick,
      ffId: m.ffId,
      reason,
      honor: ev.honor,
      placas: ev.placas,
      expelledAt: new Date().toISOString()
    });

    this.state.members = this.state.members.filter(x => x.id !== memberId);
    this.persistAndSync(`💀 ${m.nick} fue expulsado del clan`);
  }

  restoreExpelledMember(expId) {
    if (!this.isAdmin()) return;
    const exp = (this.state.expelledHistory || []).find(x => x.id === expId);
    if (!exp) return;

    this.state.members.unshift({
      id: 'm-' + Date.now(),
      nick: exp.nick,
      previousNick: '',
      ffId: exp.ffId || '000000',
      password: '123',
      role: 'Integrante',
      gameRole: '🔥 Rusher',
      avatarColor: '#3b82f6',
      readyForWar: false,
      placas: this.getMinPlacasGuerra(),
      honor: this.getMinHonorKeep(),
      faltasBase: 0,
      semanasMas3kPrevias: 0,
      updatedAt: new Date().toISOString()
    });

    this.state.expelledHistory = this.state.expelledHistory.filter(x => x.id !== expId);
    this.persistAndSync(`♻️ ${exp.nick} fue reintegrado al clan`);
  }

  deleteExpelledRecord(expId) {
    if (!this.isAdmin()) return;
    this.state.expelledHistory = (this.state.expelledHistory || []).filter(x => x.id !== expId);
    this.persistAndSync('🗑️ Borrado definitivamente del historial');
  }

  renderWhatsAppBottomBox(evaluated) {
    const box = document.getElementById('whatsappBottomRedirectBox');
    if (!box) return;

    // SOLO EL ADMINISTRADOR PUEDE VER Y MANDAR LA LISTA DE FALTAS A WHATSAPP
    if (!this.isAdmin()) {
      box.innerHTML = '';
      return;
    }

    const communityName = this.state.clanInfo?.whatsappCommunity || '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan';
    const groupName = this.state.clanInfo?.whatsappGroupName || 'Integrantes';
    const withFaults = evaluated.filter(x => x.eval.faltasEfectivas > 0 || x.eval.seVaExpulsado);

    box.innerHTML = `
      <div class="member-card" style="border: 1.5px solid #22c55e; text-align:center; padding:18px 14px;">
        <div style="font-size:0.74rem; font-weight:800; color:#4ade80; text-transform:uppercase;">
          👑 Solo Admin • WhatsApp ${this.escapeHtml(communityName)}
        </div>
        <div style="font-size:1.02rem; font-weight:900; margin:4px 0 10px;">
          Enviar lista de faltas al grupo "${this.escapeHtml(groupName)}" (${withFaults.length})
        </div>
        <button type="button" class="btn btn-success btn-block" style="padding:14px; font-size:0.95rem;" onclick="app.redirectFaultsToWhatsApp()">
          📲 Redireccionar Lista de Faltas a WhatsApp
        </button>
      </div>
    `;
  }

  buildWhatsAppFaultsMessage() {
    const communityName = this.state.clanInfo?.whatsappCommunity || '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan';
    const groupName = this.state.clanInfo?.whatsappGroupName || 'Integrantes';
    const evaluated = (this.state.members || []).map(m => ({ m, ev: this.evaluateMember(m) }));

    const withFaults = evaluated.filter(x => x.ev.faltasEfectivas > 0 && !x.ev.seVaExpulsado);
    const expelled = evaluated.filter(x => x.ev.seVaExpulsado);

    const lines = [
      `${communityName}`,
      `📢 *GRUPO: ${groupName.toUpperCase()} — LISTA DE FALTAS Y EXPULSADOS*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `⚠️ *TIENEN FALTAS (${withFaults.length}):*`,
      ...(withFaults.length
        ? withFaults.map(x => `• *${x.m.nick}* ➔ *${x.ev.faltasEfectivas}/3 Faltas* | 🏅 Placas Guerra: ${x.ev.placas} | 🔥 Honor: ${x.ev.honor}`)
        : ['• Nadie con faltas pendientes.']),
      ``,
      `💀 *SE VAN EXPULSADOS (${expelled.length}):*`,
      ...(expelled.length
        ? expelled.map(x => `• *${x.m.nick}* ➔ ${x.ev.razonesExpulsion.join(' + ')}`)
        : ['• Ningún expulsado.']),
      `━━━━━━━━━━━━━━━━━━━━`,
      `📌 *Recuerda:* Si quieres hacer más placas en Guerra de Clanes, debes jugar con los del clan ¡aunque te caigan mal! 😂🔥 (2 semanas >${this.getHonorClearThreshold().toLocaleString()} Honor quita faltas | <${this.getMinHonorKeep().toLocaleString()} Honor = expulsión).`
    ];

    return lines.join('\n');
  }

  redirectFaultsToWhatsApp() {
    if (!this.isAdmin()) return;
    const msg = this.buildWhatsAppFaultsMessage();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(msg).catch(() => {});
    }
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    window.open(waUrl, '_blank');
  }

  quickAdjust(memberId, field, delta) {
    if (!this.isAdmin()) return;
    const member = this.state.members.find(m => m.id === memberId);
    if (!member) return;
    const current = Number(member[field]) || 0;
    member[field] = Math.max(0, current + delta);
    member.updatedAt = new Date().toISOString();
    this.persistAndSync();
  }

  openMemberModal(memberId = null) {
    if (!this.isAdmin()) return;
    const modal = document.getElementById('memberModal');
    const title = document.getElementById('memberModalTitle');

    if (memberId) {
      const m = this.state.members.find(x => x.id === memberId);
      if (!m) return;
      title.textContent = `Actualizar Estado: ${m.nick}`;
      document.getElementById('editMemberId').value = m.id;
      document.getElementById('editMemberNick').value = m.nick;
      document.getElementById('editMemberFfId').value = m.ffId;
      document.getElementById('editMemberPassword').value = m.password || '123';
      document.getElementById('editMemberHonor').value = m.honor ?? 1500;
      document.getElementById('editMemberPlacas').value = m.placas ?? 80;
      document.getElementById('editMemberFaltasBase').value = m.faltasBase ?? 0;
      document.getElementById('editMemberWeeks3k').value = m.semanasMas3kPrevias ?? 0;
    } else {
      title.textContent = 'Agregar Integrante';
      document.getElementById('editMemberId').value = '';
      document.getElementById('editMemberNick').value = 'DL•';
      document.getElementById('editMemberFfId').value = '';
      document.getElementById('editMemberPassword').value = '123';
      document.getElementById('editMemberHonor').value = 1500;
      document.getElementById('editMemberPlacas').value = 80;
      document.getElementById('editMemberFaltasBase').value = 0;
      document.getElementById('editMemberWeeks3k').value = 0;
    }

    modal.classList.remove('hidden');
  }

  closeMemberModal() {
    document.getElementById('memberModal').classList.add('hidden');
  }

  saveMemberForm(e) {
    e.preventDefault();
    if (!this.isAdmin()) return;

    const id = document.getElementById('editMemberId').value;
    const colors = ['#ff4500', '#ec4899', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6'];
    const payload = {
      nick: document.getElementById('editMemberNick').value.trim(),
      ffId: document.getElementById('editMemberFfId').value.trim(),
      password: document.getElementById('editMemberPassword').value.trim() || '123',
      honor: Math.max(0, Number(document.getElementById('editMemberHonor').value) || 0),
      placas: Math.max(0, Number(document.getElementById('editMemberPlacas').value) || 0),
      faltasBase: Math.max(0, Number(document.getElementById('editMemberFaltasBase').value) || 0),
      semanasMas3kPrevias: Math.max(0, Number(document.getElementById('editMemberWeeks3k').value) || 0),
      updatedAt: new Date().toISOString()
    };

    if (id) {
      const idx = this.state.members.findIndex(m => m.id === id);
      if (idx !== -1) {
        this.state.members[idx] = { ...this.state.members[idx], ...payload };
      }
    } else {
      this.state.members.unshift({
        id: 'm-' + Date.now(),
        role: 'Integrante',
        gameRole: '🔥 Rusher',
        avatarColor: colors[this.state.members.length % colors.length],
        ...payload
      });
    }

    this.closeMemberModal();
    this.persistAndSync('✅ Estado del integrante actualizado');
  }

  deleteMember(memberId) {
    if (!this.isAdmin()) return;
    const m = this.state.members.find(x => x.id === memberId);
    if (!m) return;
    if (!confirm(`¿Seguro que quieres BORRAR COMPLETAMENTE a ${m.nick} de la aplicación?`)) return;
    this.state.members = this.state.members.filter(x => x.id !== memberId);
    this.persistAndSync(`🗑️ ${m.nick} fue borrado completamente de la app`);
  }

  // ============================================================================
  // VISTA 2: FALTAS, EXPULSIONES Y DECISIÓN DEL ADMIN
  // ============================================================================
  renderExpulsionsView() {
    const container = document.getElementById('expulsionsContent');
    if (!container) return;

    const evaluated = (this.state.members || []).map(m => ({ member: m, eval: this.evaluateMember(m) }));
    const toExpel = evaluated.filter(x => x.eval.seVaExpulsado);
    const withFaults = evaluated.filter(x => !x.eval.seVaExpulsado && x.eval.faltasEfectivas > 0);
    const history = this.state.expelledHistory || [];
    const isAdmin = this.isAdmin();

    container.innerHTML = `
      ${isAdmin ? `
        <div style="margin-bottom:16px;">
          <button type="button" class="btn btn-success btn-block" style="padding:14px;" onclick="app.redirectFaultsToWhatsApp()">
            📲 Enviar Faltas al Grupo "Integrantes" (⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan)
          </button>
        </div>
      ` : ''}

      <h3 style="font-size:0.95rem; font-weight:900; color:#f87171; margin-bottom:8px;">
        💀 En Zona de Expulsión (${toExpel.length})
      </h3>
      <div class="members-list" style="margin-bottom:18px;">
        ${toExpel.length === 0 ? `
          <div class="member-card" style="color:var(--text-muted); font-size:0.85rem;">Nadie en lista de expulsión.</div>
        ` : toExpel.map(({ member: m, eval: ev }) => `
          <div class="member-card status-expelled">
            <div class="member-top">
              <div>
                <div class="member-nick">${this.escapeHtml(m.nick)}</div>
                <div class="member-id">ID: ${this.escapeHtml(m.ffId)} • 🏅 ${ev.placas} placas • 🔥 ${ev.honor} honor</div>
              </div>
              <span class="status-badge expelled">💀 Expulsión</span>
            </div>
            <div class="verdict-line bad">${this.escapeHtml(ev.razonesExpulsion.join(' • '))}</div>
            ${isAdmin ? `
              <div class="admin-decision-bar">
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.openMemberModal('${m.id}')">🔄 Actualizar Estado</button>
                <button type="button" class="btn btn-success btn-sm" onclick="app.forgiveMemberFaults('${m.id}')">✅ Perdonar y Poner al Día</button>
                <button type="button" class="btn btn-danger btn-sm" onclick="app.executeExpulsion('${m.id}')">💀 Expulsar</button>
                <button type="button" class="btn btn-secondary btn-sm" style="color:#f87171;" onclick="app.deleteMember('${m.id}')">🗑️ Borrar de la App</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>

      <h3 style="font-size:0.95rem; font-weight:900; color:#fbbf24; margin-bottom:8px;">
        ⚠️ Tienen Faltas Acumuladas (${withFaults.length})
      </h3>
      <div class="members-list" style="margin-bottom:18px;">
        ${withFaults.length === 0 ? `
          <div class="member-card" style="color:var(--text-muted); font-size:0.85rem;">Nadie tiene faltas pendientes.</div>
        ` : withFaults.map(({ member: m, eval: ev }) => `
          <div class="member-card status-warning">
            <div class="member-top">
              <div class="member-nick">${this.escapeHtml(m.nick)}</div>
              <span class="status-badge warning">⚠️ ${ev.faltasEfectivas}/3 Faltas</span>
            </div>
            <div class="verdict-line warn">
              🏅 Placas Guerra: ${ev.placas} • 🔥 Honor: ${ev.honor.toLocaleString()} • Semanas &gt;${ev.honorClearThreshold.toLocaleString()} honor: ${ev.semanasTotalesMas3k}/2
            </div>
            ${isAdmin ? `
              <div class="admin-decision-bar">
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.openMemberModal('${m.id}')">🔄 Actualizar Estado</button>
                <button type="button" class="btn btn-success btn-sm" onclick="app.forgiveMemberFaults('${m.id}')">✅ Quitar Faltas</button>
                <button type="button" class="btn btn-secondary btn-sm" style="color:#f87171;" onclick="app.deleteMember('${m.id}')">🗑️ Borrar de la App</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>

      <h3 style="font-size:0.95rem; font-weight:900; color:var(--text-muted); margin-bottom:8px;">
        📂 Historial de Expulsados (${history.length})
      </h3>
      <div class="members-list">
        ${history.length === 0 ? `
          <div class="member-card" style="color:var(--text-muted); font-size:0.85rem;">Historial vacío.</div>
        ` : history.map(h => `
          <div class="member-card">
            <div class="member-top">
              <div>
                <div class="member-nick" style="color:#f87171;">${this.escapeHtml(h.nick)}</div>
                <div class="member-id">Motivo: ${this.escapeHtml(h.reason)}</div>
              </div>
              ${isAdmin ? `
                <div style="display:flex; gap:6px;">
                  <button type="button" class="btn btn-secondary btn-sm" onclick="app.restoreExpelledMember('${h.id}')">♻️ Reintegrar</button>
                  <button type="button" class="btn btn-danger btn-sm" onclick="app.deleteExpelledRecord('${h.id}')">🗑️</button>
                </div>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ============================================================================
  // VISTA 5: MI PERFIL GAMER (CAMBIAR NICKNAME, CONTRASEÑA, ROL Y NOTIFICACIONES)
  // ============================================================================
  renderProfileView() {
    const container = document.getElementById('profileViewContainer');
    if (!container) return;

    const myMember = this.getMyMemberObject();
    const isAdmin = this.isAdmin();
    const info = this.state.clanInfo || {};
    const creds = info.credentials || { adminUser: 'admin', adminPass: 'admin123' };
    const warCfg = info.warNotifConfig || {};
    const globalUrl = this.permanentAppUrl || this.serverInfo?.publicUrl || '';
    const lanUrls = this.serverInfo?.urls?.length ? this.serverInfo.urls : [window.location.origin];
    const bestShareUrl = globalUrl || lanUrls[0];
    const hasNotifPerm = 'Notification' in window && Notification.permission === 'granted';

    let memberProfileHtml = '';
    if (myMember) {
      const ev = this.evaluateMember(myMember);
      const badges = [];
      if (ev.honor > ev.honorClearThreshold) badges.push(`🔥 Élite +${ev.honorClearThreshold.toLocaleString()} Honor`);
      if (ev.placas >= 200) badges.push('⚔️ Destructor de Guerra (+200 Placas)');
      if (ev.faltasEfectivas === 0) badges.push('🛡️ Invicto Cero Faltas');
      badges.push('💎 Guerrero 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄');

      memberProfileHtml = `
        <div class="member-card" style="margin-bottom:14px; border-color: rgba(255, 85, 0, 0.4);">
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
            <div class="avatar-circle" style="width:56px; height:56px; font-size:1.3rem; background:${myMember.avatarColor || '#ff4500'};">
              ${this.escapeHtml(myMember.nick.replace(/^[^a-zA-Z0-9]+/, '').substring(0, 2).toUpperCase())}
            </div>
            <div>
              <h2 style="font-size:1.15rem; font-weight:900;">${this.escapeHtml(myMember.nick)}</h2>
              <div style="font-size:0.78rem; color:var(--text-muted);">ID: ${this.escapeHtml(myMember.ffId)} • ${this.escapeHtml(myMember.gameRole || '🔥 Rusher')}</div>
              ${myMember.previousNick ? `<div style="font-size:0.72rem; color:#fbbf24;">Nick anterior: ${this.escapeHtml(myMember.previousNick)}</div>` : ''}
            </div>
          </div>

          <div style="margin-bottom:14px;">
            <div class="form-label">🏅 Tus Medallas en el Clan</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">
              ${badges.map(b => `<span class="role-chip" style="background:rgba(255,85,0,0.16); color:#fbbf24; padding:4px 9px; font-size:0.73rem;">${b}</span>`).join('')}
            </div>
          </div>

          <form onsubmit="app.saveMyProfileChanges(event)">
            <div class="form-group">
              <label class="form-label">✏️ Cambiar mi Nickname (Si te cambiaste el nombre en Free Fire)</label>
              <input type="text" id="profNewNick" class="form-input" value="${this.escapeHtml(myMember.nick)}" required />
            </div>

            <div class="form-group">
              <label class="form-label">🔑 Cambiar mi Contraseña de Acceso</label>
              <input type="text" id="profNewPass" class="form-input" value="${this.escapeHtml(myMember.password || '123')}" required />
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <div class="form-group">
                <label class="form-label">🎮 Tu Rol en Escuadra</label>
                <select id="profGameRole" class="form-select">
                  <option value="🔥 Rusher" ${myMember.gameRole === '🔥 Rusher' ? 'selected' : ''}>🔥 Rusher</option>
                  <option value="🎯 Francotirador" ${myMember.gameRole === '🎯 Francotirador' ? 'selected' : ''}>🎯 Francotirador</option>
                  <option value="💣 Granadero" ${myMember.gameRole === '💣 Granadero' ? 'selected' : ''}>💣 Granadero</option>
                  <option value="🛡️ Soporte" ${myMember.gameRole === '🛡️ Soporte' ? 'selected' : ''}>🛡️ Soporte</option>
                  <option value="👑 IGL / Capitán" ${myMember.gameRole === '👑 IGL / Capitán' ? 'selected' : ''}>👑 IGL / Capitán</option>
                </select>
              </div>

              <div class="form-group">
                <label class="form-label">🎨 Color de tu Avatar</label>
                <select id="profAvatarColor" class="form-select">
                  <option value="#ff4500" ${myMember.avatarColor === '#ff4500' ? 'selected' : ''}>🔥 Naranja Fuego</option>
                  <option value="#ec4899" ${myMember.avatarColor === '#ec4899' ? 'selected' : ''}>💖 Rosa Neón</option>
                  <option value="#3b82f6" ${myMember.avatarColor === '#3b82f6' ? 'selected' : ''}>⚡ Azul Eléctrico</option>
                  <option value="#22c55e" ${myMember.avatarColor === '#22c55e' ? 'selected' : ''}>🟢 Verde Esmeralda</option>
                  <option value="#8b5cf6" ${myMember.avatarColor === '#8b5cf6' ? 'selected' : ''}>🟣 Morado Élite</option>
                  <option value="#eab308" ${myMember.avatarColor === '#eab308' ? 'selected' : ''}>🟡 Oro</option>
                </select>
              </div>
            </div>

            <button type="submit" class="btn btn-fire btn-block" style="margin-top:4px;">
              💾 Guardar Mi Nick y Contraseña
            </button>
          </form>
        </div>
      `;
    }

    container.innerHTML = `
      ${memberProfileHtml}

      <!-- TARJETA DE NOTIFICACIONES DE GUERRA DE CLANES -->
      <div class="member-card" style="margin-bottom:14px;">
        <h3 style="font-size:1rem; font-weight:900; margin-bottom:6px;">
          🔔 Notificaciones de Guerra de Clanes
        </h3>
        <p style="font-size:0.8rem; color:var(--text-muted); line-height:1.45; margin-bottom:10px;">
          Avisos automáticos todos los <strong>Miércoles, Sábados y Domingos</strong>:<br/>
          • <strong>1:00 PM:</strong> Aviso para alistarse.<br/>
          • <strong>6:00 PM:</strong> Aviso de que ya empezó la Guerra.<br/>
          <em>"Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal!"</em>
        </p>

        <div style="display:flex; flex-direction:column; gap:8px;">
          <button type="button" class="btn ${hasNotifPerm ? 'btn-success' : 'btn-fire'} btn-block" onclick="app.requestNotificationPermission()">
            ${hasNotifPerm ? '🔔 Probar Notificación en mi Celular' : '🔔 Activar Notificaciones en mi Celular'}
          </button>

          ${isAdmin ? `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:4px;">
              <button type="button" class="btn btn-purple btn-sm" onclick="app.sendLiveWarNotification('1pm')">
                📢 Mandar Aviso 1 PM a Todos
              </button>
              <button type="button" class="btn btn-danger btn-sm" onclick="app.sendLiveWarNotification('6pm')">
                🚨 Mandar Aviso 6 PM a Todos
              </button>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- COMPARTIR LINK MUNDIAL E INSTALAR APP -->
      <div class="member-card" style="margin-bottom:14px;">
        <h3 style="font-size:1rem; font-weight:900; margin-bottom:6px;">🌍 Link Mundial del Clan</h3>
        <div style="background:var(--bg-input); padding:11px; border-radius:10px; font-weight:800; font-size:0.84rem; word-break:break-all; margin-bottom:10px;">
          ${this.escapeHtml(bestShareUrl)}
        </div>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <button type="button" class="btn btn-success btn-block" onclick="app.shareAppLinkToWhatsApp('${this.escapeHtml(bestShareUrl)}')">
            📲 Compartir Link de la App por WhatsApp
          </button>
          <button type="button" class="btn btn-secondary btn-block" onclick="app.triggerInstallApp()">
            📲 Instalar Aplicación en mi Celular
          </button>
        </div>
      </div>

      ${isAdmin ? `
        <div class="member-card" id="adminSettingsCard">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
            <h3 style="font-size:1rem; font-weight:900;">👑 Ajustes de Administrador</h3>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn-fire btn-sm" onclick="app.openOcrModal('honor')">
                📸 Capturas Honor
              </button>
              <button type="button" class="btn btn-purple btn-sm" onclick="app.openOcrModal('placas')">
                🏅 Capturas Placas
              </button>
              <button type="button" class="btn btn-success btn-sm" onclick="app.openOcrModal('members')">
                🆔 Capturas ID/Nombres
              </button>
            </div>
          </div>
          <form onsubmit="app.saveAdminSettings(event)">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <div class="form-group">
                <label class="form-label">Usuario Admin</label>
                <input type="text" id="cfgAdminUser" class="form-input" value="${this.escapeHtml(creds.adminUser)}" required />
              </div>
              <div class="form-group">
                <label class="form-label">Contraseña Admin</label>
                <input type="text" id="cfgAdminPass" class="form-input" value="${this.escapeHtml(creds.adminPass)}" required />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">🏅 Límite Mínimo de Placas en Guerra (Menos de esto = +1 Falta)</label>
              <input type="number" min="1" id="cfgMinPlacas" class="form-input" value="${this.getMinPlacasGuerra()}" required />
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <div class="form-group">
                <label class="form-label">🔥 Límite Mín. Honor (Expulsión)</label>
                <input type="number" min="0" id="cfgMinHonorKeep" class="form-input" value="${this.getMinHonorKeep()}" required />
              </div>
              <div class="form-group">
                <label class="form-label">🧹 Honor p/ Quitar Faltas (2 sem.)</label>
                <input type="number" min="1" id="cfgHonorClearThreshold" class="form-input" value="${this.getHonorClearThreshold()}" required />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">🕐 Mensaje Notificación 1:00 PM (Mié, Sáb y Dom)</label>
              <textarea id="cfgMsg1pm" class="form-textarea" style="min-height:65px;">${this.escapeHtml(warCfg.msg1pm || '¡Alístense todos en ⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄! Hoy es día de Guerra de Clanes. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! 😂🔥')}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">🕕 Mensaje Notificación 6:00 PM (Mié, Sáb y Dom)</label>
              <textarea id="cfgMsg6pm" class="form-textarea" style="min-height:65px;">${this.escapeHtml(warCfg.msg6pm || '🚨 ¡YA EMPEZÓ LA GUERRA DE CLANES! Todos a jugar ya. Recuerda que si quieres más placas, debes de jugar con los del clan, ¡aunque te caigan mal! ⚔️🏅 El que no haga placas suma falta.')}</textarea>
            </div>

            <button type="submit" class="btn btn-fire btn-block">💾 Guardar Ajustes de Admin</button>
          </form>
        </div>
      ` : ''}
    `;
  }

  saveMyProfileChanges(e) {
    e.preventDefault();
    const myMember = this.getMyMemberObject();
    if (!myMember) return;

    const newNick = document.getElementById('profNewNick').value.trim();
    const newPass = document.getElementById('profNewPass').value.trim();
    const newRole = document.getElementById('profGameRole').value;
    const newColor = document.getElementById('profAvatarColor').value;

    if (!newNick || !newPass) {
      this.showToast('⚠️ El Nick y la Contraseña no pueden estar vacíos');
      return;
    }

    const oldNick = myMember.nick;
    if (oldNick !== newNick) {
      myMember.previousNick = oldNick;
      myMember.nick = newNick;
      (this.state.posts || []).forEach(p => {
        if (p.authorNick === oldNick) p.authorNick = newNick;
      });
    }

    myMember.password = newPass;
    myMember.gameRole = newRole;
    myMember.avatarColor = newColor;
    myMember.updatedAt = new Date().toISOString();

    this.session.nick = newNick;
    this.saveSession(this.session);

    this.persistAndSync('✅ ¡Tu Nickname, Contraseña y Perfil se actualizaron!');
  }

  // ============================================================================
  // VISTA 3: MURO SOCIAL (CLANGRAM)
  // ============================================================================
  renderClanGram() {
    const storiesBar = document.getElementById('clangramStories');
    const feedEl = document.getElementById('clangramFeed');
    if (!storiesBar || !feedEl) return;

    const members = this.state.members || [];
    const topHonor = [...members].sort((a, b) => (b.honor || 0) - (a.honor || 0))[0];
    const topPlacas = [...members].sort((a, b) => (b.placas || 0) - (a.placas || 0))[0];

    storiesBar.innerHTML = `
      <div class="story-item" onclick="app.openNewPostModal()">
        <div class="story-ring"><div class="story-inner">➕</div></div>
        <span class="story-label">Subir</span>
      </div>
      ${topHonor ? `
        <div class="story-item" onclick="app.openStoryViewer('honor')">
          <div class="story-ring"><div class="story-inner">🔥</div></div>
          <span class="story-label">Top Honor</span>
        </div>
      ` : ''}
      ${topPlacas ? `
        <div class="story-item" onclick="app.openStoryViewer('placas')">
          <div class="story-ring"><div class="story-inner">🏅</div></div>
          <span class="story-label">Top Placas</span>
        </div>
      ` : ''}
    `;

    const myNick = this.session ? this.session.nick : '';
    const isAdmin = this.isAdmin();
    const posts = this.state.posts || [];

    if (posts.length === 0) {
      feedEl.innerHTML = `
        <div class="member-card" style="text-align:center; padding:28px;">
          <p style="color:var(--text-muted); margin-bottom:10px;">Aún no hay publicaciones.</p>
          <button type="button" class="btn btn-fire btn-sm" onclick="app.openNewPostModal()">➕ Subir la primera</button>
        </div>
      `;
      return;
    }

    feedEl.innerHTML = posts.map(post => {
      const likes = Array.isArray(post.likes) ? post.likes : [];
      const comments = Array.isArray(post.comments) ? post.comments : [];
      const isLiked = myNick && likes.includes(myNick);
      const canDeletePost = isAdmin || (myNick && post.authorNick.toLowerCase() === myNick.toLowerCase());

      return `
        <article class="ig-post">
          <div class="ig-post-header">
            <div style="font-weight:800; font-size:0.92rem;">${this.escapeHtml(post.authorNick)}</div>
            ${canDeletePost ? `
              <button type="button" class="btn btn-secondary btn-sm" style="color:#f87171;" onclick="app.deletePost('${post.id}')">🗑️ Borrar</button>
            ` : ''}
          </div>

          <div class="ig-media-box" ondblclick="app.toggleLike('${post.id}')">
            ${post.imageData && post.imageData.startsWith('data:') ? `
              <img src="${post.imageData}" alt="Post" />
            ` : `
              <div class="ig-banner-card">
                <div style="font-size:1.2rem; font-weight:900; margin-bottom:6px;">${this.escapeHtml(post.cardTitle || '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan')}</div>
                <div style="font-size:0.92rem; color:rgba(255,255,255,0.88);">${this.escapeHtml(post.caption)}</div>
              </div>
            `}
          </div>

          <div class="ig-actions-bar">
            <div style="display:flex; gap:14px;">
              <button type="button" class="ig-icon-btn" onclick="app.toggleLike('${post.id}')">
                <span>${isLiked ? '❤️' : '🤍'}</span>
                <span style="font-size:0.9rem; font-weight:800;">${likes.length}</span>
              </button>
              <button type="button" class="ig-icon-btn" onclick="document.getElementById('commentInput-${post.id}').focus()">
                <span>💬</span>
                <span style="font-size:0.9rem; font-weight:800;">${comments.length}</span>
              </button>
            </div>
          </div>

          <div class="ig-body">
            <div style="font-size:0.88rem; margin-bottom:8px;">
              <strong>${this.escapeHtml(post.authorNick)}</strong> ${this.escapeHtml(post.caption)}
            </div>

            ${comments.map(c => {
              const canDel = isAdmin || (myNick && c.authorNick.toLowerCase() === myNick.toLowerCase());
              return `
                <div style="display:flex; justify-content:space-between; font-size:0.82rem; padding:5px 8px; background:rgba(0,0,0,0.25); border-radius:8px; margin-bottom:5px;">
                  <div><strong>${this.escapeHtml(c.authorNick)}:</strong> ${this.escapeHtml(c.text)}</div>
                  ${canDel ? `<button type="button" style="background:none; border:none; color:#f87171; cursor:pointer;" onclick="app.deleteComment('${post.id}', '${c.id}')">✕</button>` : ''}
                </div>
              `;
            }).join('')}

            <form style="display:flex; gap:6px; margin-top:8px;" onsubmit="app.addComment(event, '${post.id}')">
              <input type="text" id="commentInput-${post.id}" class="form-input" style="padding:9px 11px; font-size:0.85rem;" placeholder="Comentar..." required />
              <button type="submit" class="btn btn-fire btn-sm">Enviar</button>
            </form>
          </div>
        </article>
      `;
    }).join('');
  }

  openStoryViewer(type) {
    const members = this.state.members || [];
    const modal = document.getElementById('storyModal');
    const content = document.getElementById('storyModalContent');
    if (!modal || !content) return;

    if (type === 'honor') {
      const top = [...members].sort((a, b) => (b.honor || 0) - (a.honor || 0))[0];
      content.innerHTML = `
        <div style="font-size:2.8rem;">🔥</div>
        <div style="font-size:0.8rem; color:var(--text-muted); font-weight:800;">LÍDER DE HONOR</div>
        <h2 style="font-size:1.4rem; font-weight:900; margin:6px 0;">${this.escapeHtml(top.nick)}</h2>
        <div style="font-size:1.8rem; font-weight:900; color:#fbbf24;">${(top.honor || 0).toLocaleString()} Honor</div>
      `;
    } else {
      const top = [...members].sort((a, b) => (b.placas || 0) - (a.placas || 0))[0];
      content.innerHTML = `
        <div style="font-size:2.8rem;">🏅</div>
        <div style="font-size:0.8rem; color:var(--text-muted); font-weight:800;">LÍDER EN PLACAS DE GUERRA</div>
        <h2 style="font-size:1.4rem; font-weight:900; margin:6px 0;">${this.escapeHtml(top.nick)}</h2>
        <div style="font-size:1.8rem; font-weight:900; color:#38bdf8;">${(top.placas || 0).toLocaleString()} Placas</div>
      `;
    }
    modal.classList.remove('hidden');
  }

  closeStoryModal() {
    document.getElementById('storyModal').classList.add('hidden');
  }

  openNewPostModal() {
    this.uploadedImageData = '';
    document.getElementById('postImageInput').value = '';
    document.getElementById('postImagePreviewBox').classList.add('hidden');
    document.getElementById('bannerBuilderFields').classList.remove('hidden');
    document.getElementById('postCardTitle').value = '';
    document.getElementById('postCaption').value = '';
    document.getElementById('newPostModal').classList.remove('hidden');
  }

  closeNewPostModal() {
    document.getElementById('newPostModal').classList.add('hidden');
  }

  handlePostImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 850;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        this.uploadedImageData = canvas.toDataURL('image/jpeg', 0.8);
        document.getElementById('postImagePreview').src = this.uploadedImageData;
        document.getElementById('postImagePreviewBox').classList.remove('hidden');
        document.getElementById('bannerBuilderFields').classList.add('hidden');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  clearUploadedImage() {
    this.uploadedImageData = '';
    document.getElementById('postImageInput').value = '';
    document.getElementById('postImagePreviewBox').classList.add('hidden');
    document.getElementById('bannerBuilderFields').classList.remove('hidden');
  }

  submitNewPost(e) {
    e.preventDefault();
    const authorNick = this.session ? this.session.nick : 'Integrante';
    const caption = document.getElementById('postCaption').value.trim();
    const cardTitle = document.getElementById('postCardTitle').value.trim() || `⚔️ ${authorNick}`;

    if (!this.state.posts) this.state.posts = [];
    this.state.posts.unshift({
      id: 'p-' + Date.now(),
      authorNick,
      isAdmin: this.isAdmin(),
      cardTitle,
      imageData: this.uploadedImageData || '',
      caption,
      likes: [],
      comments: [],
      createdAt: new Date().toISOString()
    });

    this.closeNewPostModal();
    this.persistAndSync('📸 Publicado');
  }

  toggleLike(postId) {
    const post = (this.state.posts || []).find(p => p.id === postId);
    if (!post) return;
    const myNick = this.session ? this.session.nick : 'Integrante';
    if (!Array.isArray(post.likes)) post.likes = [];
    const idx = post.likes.indexOf(myNick);
    if (idx === -1) post.likes.push(myNick);
    else post.likes.splice(idx, 1);
    this.persistAndSync();
  }

  addComment(event, postId) {
    event.preventDefault();
    const input = document.getElementById(`commentInput-${postId}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const post = (this.state.posts || []).find(p => p.id === postId);
    if (!post) return;
    if (!Array.isArray(post.comments)) post.comments = [];
    post.comments.push({
      id: 'c-' + Date.now(),
      authorNick: this.session ? this.session.nick : 'Integrante',
      text,
      createdAt: new Date().toISOString()
    });
    input.value = '';
    this.persistAndSync();
  }

  deleteComment(postId, commentId) {
    const post = (this.state.posts || []).find(p => p.id === postId);
    if (!post || !Array.isArray(post.comments)) return;
    post.comments = post.comments.filter(c => c.id !== commentId);
    this.persistAndSync();
  }

  deletePost(postId) {
    if (!confirm('¿Borrar esta publicación?')) return;
    this.state.posts = (this.state.posts || []).filter(p => p.id !== postId);
    this.persistAndSync('🗑️ Publicación borrada');
  }

  // ============================================================================
  // VISTA 4: BUZÓN DE QUEJAS
  // ============================================================================
  submitComplaint(e) {
    e.preventDefault();
    const isAnonymous = document.getElementById('compAnonymous').value === 'true';
    const category = document.getElementById('compCategory').value;
    const message = document.getElementById('compMessage').value.trim();
    if (!message) return;

    const realNick = this.session ? this.session.nick : 'Integrante';
    if (!this.state.complaints) this.state.complaints = [];
    this.state.complaints.unshift({
      id: 'q-' + Date.now(),
      category,
      isAnonymous,
      authorNick: isAnonymous ? 'Anónimo' : realNick,
      deviceToken: this.deviceId,
      message,
      status: 'Pendiente',
      adminReply: '',
      createdAt: new Date().toISOString()
    });

    document.getElementById('compMessage').value = '';
    this.persistAndSync('📨 Queja enviada a los Administradores');
  }

  renderComplaintsView() {
    const container = document.getElementById('complaintsListSection');
    if (!container) return;
    const allComplaints = this.state.complaints || [];
    const isAdmin = this.isAdmin();

    if (isAdmin) {
      container.innerHTML = `
        <h3 style="font-size:0.95rem; font-weight:900; margin-bottom:10px;">👑 Quejas Recibidas (${allComplaints.length})</h3>
        <div class="members-list">
          ${allComplaints.length === 0 ? `<div class="member-card" style="color:var(--text-muted);">Buzón vacío.</div>` : allComplaints.map(q => `
            <div class="member-card">
              <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                <strong>${q.isAnonymous ? '🕵️ Anónimo' : `👤 ${this.escapeHtml(q.authorNick)}`} • ${this.escapeHtml(q.category)}</strong>
                <span class="status-badge ${q.status === 'Resuelta' ? 'ok' : 'warning'}">${this.escapeHtml(q.status)}</span>
              </div>
              <p style="font-size:0.88rem; margin-bottom:10px;">"${this.escapeHtml(q.message)}"</p>
              <div style="display:flex; gap:6px;">
                <input type="text" id="replyInput-${q.id}" class="form-input" style="padding:8px 10px; font-size:0.84rem;" placeholder="Responder..." value="${this.escapeHtml(q.adminReply || '')}" />
                <button type="button" class="btn btn-fire btn-sm" onclick="app.saveComplaintReply('${q.id}')">Responder</button>
                <button type="button" class="btn btn-danger btn-sm" onclick="app.deleteComplaint('${q.id}')">🗑️</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      const myComplaints = allComplaints.filter(q => q.deviceToken === this.deviceId);
      container.innerHTML = myComplaints.length === 0 ? '' : `
        <h3 style="font-size:0.9rem; font-weight:900; margin-bottom:8px;">Mis quejas enviadas</h3>
        <div class="members-list">
          ${myComplaints.map(q => `
            <div class="member-card">
              <div style="font-size:0.85rem;">"${this.escapeHtml(q.message)}"</div>
              ${q.adminReply ? `<div class="verdict-line" style="margin-top:6px;"><strong>👑 Admin:</strong> ${this.escapeHtml(q.adminReply)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  saveComplaintReply(compId) {
    if (!this.isAdmin()) return;
    const q = (this.state.complaints || []).find(x => x.id === compId);
    if (!q) return;
    const input = document.getElementById(`replyInput-${compId}`);
    if (input) q.adminReply = input.value.trim();
    q.status = 'Resuelta';
    this.persistAndSync('✅ Respuesta guardada');
  }

  deleteComplaint(compId) {
    if (!this.isAdmin()) return;
    this.state.complaints = (this.state.complaints || []).filter(x => x.id !== compId);
    this.persistAndSync('🗑️ Eliminada');
  }

  shareAppLinkToWhatsApp(url) {
    const communityName = this.state.clanInfo?.whatsappCommunity || '⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan';
    const groupName = this.state.clanInfo?.whatsappGroupName || 'Integrantes';
    const text = [
      `${communityName}`,
      `📲 *APP OFICIAL DEL GRUPO: ${groupName.toUpperCase()}*`,
      ``,
      `Entren aquí para registrarse con su ID de Free Fire y ver su *Honor, Placas de Guerra de Clanes y Faltas*:`,
      `👉 ${url}`
    ].join('\n');
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
  }

  saveAdminSettings(e) {
    e.preventDefault();
    if (!this.isAdmin()) return;
    this.state.clanInfo.credentials = {
      adminUser: document.getElementById('cfgAdminUser').value.trim(),
      adminPass: document.getElementById('cfgAdminPass').value.trim()
    };
    const minPlacas = Math.max(1, Number(document.getElementById('cfgMinPlacas').value) || 80);
    const minHonor = Math.max(0, Number(document.getElementById('cfgMinHonorKeep').value) || 0);
    const clearHonor = Math.max(1, Number(document.getElementById('cfgHonorClearThreshold').value) || 3000);

    this.state.clanInfo.minPlacasGuerra = minPlacas;
    this.state.clanInfo.minHonorKeep = minHonor;
    this.state.clanInfo.honorClearThreshold = clearHonor;
    if (this.state.clanInfo.rules) {
      this.state.clanInfo.rules.minHonorKeep = minHonor;
      this.state.clanInfo.rules.honorClearThreshold = clearHonor;
    }

    this.state.clanInfo.warNotifConfig = {
      msg1pm: document.getElementById('cfgMsg1pm').value.trim(),
      msg6pm: document.getElementById('cfgMsg6pm').value.trim()
    };
    this.persistAndSync('✅ Límites de Honor, Placas y Ajustes guardados');
  }

  // ============================================================================
  // ACTUALIZAR HONOR O PLACAS VIENDO CAPTURAS DE PANTALLA (OCR + REVISIÓN VISUAL)
  // ============================================================================
  openOcrHonorModal() {
    this.openOcrModal('honor');
  }

  openOcrModal(mode = 'honor') {
    if (!this.isAdmin()) return;
    const validMode = mode === 'placas' ? 'placas' : mode === 'members' ? 'members' : 'honor';
    this.ocrState = {
      mode: validMode,
      images: [],
      selectedImageIdx: 0,
      scanning: false,
      progressText: '',
      detectedMap: {},
      manualEdits: {},
      memberRows: [],
      searchQuery: '',
      rawLines: []
    };
    const titleEl = document.getElementById('ocrModalTitle');
    if (titleEl) {
      titleEl.textContent = validMode === 'placas'
        ? '🏅 Actualizar Placas de Guerra con Capturas'
        : validMode === 'members'
          ? '🆔 Agregar / Actualizar IDs y Nombres con Capturas'
          : '📸 Actualizar Honor con Capturas';
    }
    const modal = document.getElementById('ocrHonorModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    this.renderOcrHonorModal();
  }

  closeOcrHonorModal() {
    document.getElementById('ocrHonorModal')?.classList.add('hidden');
  }

  loadTesseractLibrary() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (this._tesseractPromise) return this._tesseractPromise;
    this._tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error('No se pudo cargar el lector OCR'));
      document.head.appendChild(s);
    });
    return this._tesseractPromise;
  }

  normalizeFancyUnicode(str) {
    const smallCapsMap = {
      'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g',
      'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n',
      'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u',
      'ᴠ': 'v', 'ᴡ': 'w', 'x': 'x', 'ʏ': 'y', 'ᴢ': 'z',
      'ᴁ': 'ae', 'ᴃ': 'b', 'ᴆ': 'd', 'ᴈ': 'e', 'ᴉ': 'i', 'ᴊ': 'j', 'ᴌ': 'l',
      'ᴎ': 'n', 'ᴑ': 'o', 'ᴓ': 'o', 'ᴕ': 'ou', 'ᴘ': 'p', 'ᴙ': 'r', 'ᴚ': 'r',
      'ᴛ': 't', 'ᴜ': 'u', 'ᴝ': 'u', 'ᴞ': 'u', 'ᴟ': 'm', 'ᴠ': 'v', 'ᴡ': 'w',
      'ᴢ': 'z', 'ᴣ': 'z', 'ᴦ': 'g', 'ᴧ': 'a', 'ᴨ': 'p', 'ᴩ': 'r', 'ᴪ': 'p',
      'α': 'a', 'в': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'м': 'm', 'η': 'n',
      'σ': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
      'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
      'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b',
      'ⓐ': 'a', 'ⓑ': 'b', 'ⓒ': 'c', 'ⓓ': 'd', 'ⓔ': 'e', 'ⓕ': 'f', 'ⓖ': 'g',
      'ⓗ': 'h', 'ⓘ': 'i', 'ⓙ': 'j', 'ⓚ': 'k', 'ⓛ': 'l', 'ⓜ': 'm', 'ⓝ': 'n',
      'ⓞ': 'o', 'ⓟ': 'p', 'ⓠ': 'q', 'ⓡ': 'r', 'ⓢ': 's', 'ⓣ': 't', 'ⓤ': 'u',
      'ⓥ': 'v', 'ⓦ': 'w', 'ⓧ': 'x', 'ⓨ': 'y', 'ⓩ': 'z',
      '卂': 'a', '乃': 'b', '匚': 'c', '刀': 'd', '乇': 'e', '下': 'f', 'ム': 'g',
      '卄': 'h', '工': 'i', '丁': 'j', '长': 'k', 'ㄥ': 'l', '爪': 'm', '几': 'n',
      '口': 'o', '尸': 'p', 'Ɋ': 'q', '尺': 'r', '丂': 's', 'ㄒ': 't', '凵': 'u',
      'リ': 'v', '山': 'w', '乂': 'x', 'ㄚ': 'y', '乙': 'z',
      'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'ß': 'ss'
    };

    let s = String(str || '').normalize('NFKC');
    let out = '';
    for (const ch of s) {
      const lower = ch.toLowerCase();
      if (smallCapsMap[ch]) {
        out += smallCapsMap[ch];
      } else if (smallCapsMap[lower]) {
        out += smallCapsMap[lower];
      } else {
        out += ch;
      }
    }
    // Quitar acentos y caracteres invisibles de Free Fire
    return out
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u200B-\u200D\uFEFF\u3164\u00A0]/g, '')
      .toLowerCase();
  }

  normalizeNickForMatch(str) {
    return this.normalizeFancyUnicode(str).replace(/[^a-z0-9]/g, '');
  }

  toOcrSkeleton(str) {
    return this.normalizeNickForMatch(str)
      .replace(/0/g, 'o')
      .replace(/1/g, 'i')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/7/g, 't')
      .replace(/8/g, 'b');
  }

  levenshtein(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[a.length][b.length];
  }

  findBestMemberMatchFromLine(lineText) {
    const cleanLine = this.normalizeNickForMatch(lineText);
    const skelLine = this.toOcrSkeleton(lineText);
    if (cleanLine.length < 2) return null;

    const rawTokens = this.normalizeFancyUnicode(lineText)
      .split(/[\s|•·,;:()[\]{}_-]+/)
      .map(t => t.replace(/[^a-z0-9]/g, ''))
      .filter(t => t.length >= 3);

    let bestMember = null;
    let bestScore = 0;

    for (const m of (this.state.members || [])) {
      const candidates = [m.nick, m.previousNick].filter(Boolean);
      for (const rawName of candidates) {
        const normName = this.normalizeNickForMatch(rawName);
        const skelName = this.toOcrSkeleton(rawName);
        if (normName.length < 2) continue;

        let score = 0;
        if (
          cleanLine.includes(normName) ||
          (normName.length >= 4 && cleanLine.length >= 3 && normName.includes(cleanLine)) ||
          (skelName.length >= 3 && skelLine.includes(skelName)) ||
          (skelName.length >= 4 && skelLine.length >= 3 && skelName.includes(skelLine))
        ) {
          score = 1.0;
        } else {
          const nameTokens = this.normalizeFancyUnicode(rawName)
            .split(/[\s•·._-]+/)
            .map(t => t.replace(/[^a-z0-9]/g, ''))
            .filter(t => t.length >= 3 && t !== 'dl');

          for (const nt of nameTokens) {
            const skelNt = this.toOcrSkeleton(nt);
            if (cleanLine.includes(nt) || (skelNt.length >= 3 && skelLine.includes(skelNt))) {
              score = Math.max(score, 0.9);
            }
            for (const rt of rawTokens) {
              if (rt.length >= 3 && (nt.includes(rt) || rt.includes(nt))) {
                score = Math.max(score, 0.86);
              }
              const maxLen = Math.max(nt.length, rt.length);
              if (maxLen >= 4) {
                const dist = this.levenshtein(nt, rt);
                const sim = 1 - dist / maxLen;
                if (sim >= 0.72) score = Math.max(score, sim * 0.9);
              }
            }
          }

          if (score === 0 && normName.length >= 4) {
            for (const rt of rawTokens) {
              if (rt.length >= 3 && (normName.includes(rt) || rt.includes(normName))) {
                score = Math.max(score, 0.85);
              }
              const maxLen = Math.max(normName.length, rt.length);
              const dist = this.levenshtein(normName, rt);
              const sim = 1 - dist / maxLen;
              if (sim >= 0.7) score = Math.max(score, sim * 0.85);
            }
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestMember = m;
        }
      }
    }

    return bestScore >= 0.7 ? bestMember : null;
  }

  extractStatFromText(text, mode = 'honor') {
    if (mode === 'placas') {
      // En Guerra de Clanes las placas suelen ser números de 1 a 5 dígitos (ej. 30, 80, 145, 420)
      const matches = String(text || '').match(/\d{1,3}(?:[.,]\d{3})+|\d{1,5}/g) || [];
      const nums = matches
        .map(s => Number(s.replace(/[.,]/g, '')))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 50000);
      if (nums.length === 0) return null;
      // Si hay varios números (ej. nivel + placas), preferimos el último o el >= 10
      const plausible = nums.filter(n => n >= 10);
      return plausible.length > 0 ? plausible[plausible.length - 1] : nums[nums.length - 1];
    }

    const matches = String(text || '').match(/\d{1,3}(?:[.,\s]\d{3})+|\d{3,6}/g) || [];
    const nums = matches
      .map(s => Number(s.replace(/[.,\s]/g, '')))
      .filter(n => Number.isFinite(n) && n >= 100 && n <= 200000);
    if (nums.length === 0) return null;
    return Math.max(...nums);
  }

  preprocessImageForOcr(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = img.width < 1200 ? 1.8 : 1.25;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.filter = 'grayscale(100%) contrast(155%) brightness(115%)';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async handleOcrScreenshotsSelected(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const loaded = await Promise.all(files.map(file => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve({ name: file.name, dataUrl: e.target.result });
      reader.readAsDataURL(file);
    })));

    this.ocrState.images = [...this.ocrState.images, ...loaded];
    this.ocrState.selectedImageIdx = 0;
    this.renderOcrHonorModal();
    await this.runOcrOnScreenshots(loaded);
  }

  extractFfIdFromText(text) {
    const m = String(text || '').match(/(?:id[:\s]*)?(\d{7,12})\b/i);
    return m ? m[1] : null;
  }

  cleanNickFromIdLine(text) {
    let cleaned = String(text || '')
      .replace(/id[:\s]*\d{5,12}/gi, ' ')
      .replace(/\b\d{7,12}\b/g, ' ')
      .replace(/\b(nv|lv|lvl|nivel|lider|decano|veterano|miembro|integrante)\b\.?\s*\d*/gi, ' ')
      .replace(/^\d{1,3}[\s.)-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned;
  }

  processMembersOcrLines(lines) {
    const members = this.state.members || [];
    const seenKeys = new Set(
      (this.ocrState.memberRows || []).map(r => r.ffId || this.normalizeNickForMatch(r.nick))
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ffId = this.extractFfIdFromText(line);
      let candidateNick = this.cleanNickFromIdLine(line);

      // Si la línea solo traía "ID: 1234567890", el nombre suele estar en la línea anterior
      if (ffId && this.normalizeNickForMatch(candidateNick).length < 2 && i > 0) {
        const prevClean = this.cleanNickFromIdLine(lines[i - 1]);
        if (this.normalizeNickForMatch(prevClean).length >= 2) {
          candidateNick = prevClean;
        }
      }

      if (!ffId && this.normalizeNickForMatch(candidateNick).length < 3) continue;

      const byId = ffId ? members.find(m => m.ffId === ffId) : null;
      const byNick = candidateNick ? this.findBestMemberMatchFromLine(candidateNick) : null;
      const matched = byId || byNick;

      const dedupKey = ffId || (matched ? matched.id : this.normalizeNickForMatch(candidateNick));
      if (!dedupKey || seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      let action = 'add';
      if (matched) {
        const sameId = !ffId || matched.ffId === ffId;
        const sameNick = !candidateNick || matched.nick === candidateNick;
        action = (sameId && sameNick) ? 'unchanged' : 'update';
      }

      this.ocrState.memberRows.push({
        rowId: 'row-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        matchedMemberId: matched ? matched.id : null,
        matchedOldNick: matched ? matched.nick : '',
        matchedOldId: matched ? matched.ffId : '',
        nick: candidateNick || (matched ? matched.nick : ''),
        ffId: ffId || (matched ? matched.ffId : ''),
        action,
        checked: action !== 'unchanged'
      });
    }
  }

  addManualOcrMemberRow() {
    if (!this.ocrState) return;
    if (!this.ocrState.memberRows) this.ocrState.memberRows = [];
    this.ocrState.memberRows.push({
      rowId: 'row-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      matchedMemberId: null,
      matchedOldNick: '',
      matchedOldId: '',
      nick: '',
      ffId: '',
      action: 'add',
      checked: true
    });
    this.renderOcrHonorModal();
  }

  updateOcrMemberRowField(rowId, field, value) {
    const row = (this.ocrState?.memberRows || []).find(r => r.rowId === rowId);
    if (!row) return;
    row[field] = String(value || '').trim();
    row.checked = true;

    // Re-evaluar si el ID o nombre parcial coincide con alguien ya existente
    const members = this.state.members || [];
    const byId = row.ffId ? members.find(m => m.ffId === row.ffId) : null;
    const byNick = row.nick ? this.findBestMemberMatchFromLine(row.nick) : null;
    const matched = byId || byNick;
    row.matchedMemberId = matched ? matched.id : null;
    row.matchedOldNick = matched ? matched.nick : '';
    row.matchedOldId = matched ? matched.ffId : '';
    row.action = matched ? 'update' : 'add';

    const badge = document.getElementById(`ocrRowBadge-${rowId}`);
    if (badge) {
      badge.textContent = matched
        ? `🔄 Actualizar a: ${matched.nick} (${matched.ffId || 'sin ID'})`
        : '➕ Nuevo integrante';
      badge.style.color = matched ? '#fbbf24' : '#4ade80';
    }
  }

  toggleOcrMemberRowChecked(rowId, checked) {
    const row = (this.ocrState?.memberRows || []).find(r => r.rowId === rowId);
    if (row) row.checked = checked;
  }

  async runOcrOnScreenshots(imagesToScan) {
    if (!imagesToScan || !imagesToScan.length) return;
    const mode = this.ocrState?.mode || 'honor';
    const statLabel = mode === 'placas' ? 'Placas' : mode === 'members' ? 'IDs y Nombres' : 'Honor';

    this.ocrState.scanning = true;
    this.ocrState.progressText = `⏳ Iniciando lector de ${statLabel}...`;
    this.renderOcrHonorModal();

    try {
      const Tesseract = await this.loadTesseractLibrary();
      for (let idx = 0; idx < imagesToScan.length; idx++) {
        const item = imagesToScan[idx];
        this.ocrState.progressText = `🔍 Leyendo captura ${idx + 1} de ${imagesToScan.length}...`;
        this.renderOcrHonorModal();

        const processedUrl = await this.preprocessImageForOcr(item.dataUrl);
        const result = await Tesseract.recognize(processedUrl, 'spa+eng', {
          logger: (m) => {
            if (m.status === 'recognizing text' && typeof m.progress === 'number') {
              const pct = Math.round(m.progress * 100);
              const progEl = document.getElementById('ocrProgressLabel');
              if (progEl) progEl.textContent = `🔍 Leyendo captura ${idx + 1}/${imagesToScan.length} (${pct}%)...`;
            }
          }
        });

        const lines = String(result?.data?.text || '')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);

        this.ocrState.rawLines.push(...lines);

        if (mode === 'members') {
          this.processMembersOcrLines(lines);
        } else {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const member = this.findBestMemberMatchFromLine(line);
            if (member) {
              let detectedValue = this.extractStatFromText(line, mode);
              if (detectedValue === null && lines[i + 1]) {
                detectedValue = this.extractStatFromText(lines[i + 1], mode);
              }
              if (detectedValue !== null) {
                this.ocrState.detectedMap[member.id] = {
                  value: detectedValue,
                  checked: true,
                  sourceLine: line
                };
              }
            }
          }
        }
      }
      const totalFound = mode === 'members'
        ? (this.ocrState.memberRows || []).length
        : Object.keys(this.ocrState.detectedMap).length;
      this.ocrState.progressText = `✅ Escaneo de ${statLabel} listo (${totalFound} detectados). Revisa viendo la captura abajo:`;
    } catch (err) {
      this.ocrState.progressText = `⚠️ No se pudo leer automáticamente; puedes ver la captura aquí abajo y escribir ${statLabel} directo.`;
    } finally {
      this.ocrState.scanning = false;
      this.renderOcrHonorModal();
    }
  }

  selectOcrPreviewImage(idx) {
    this.ocrState.selectedImageIdx = idx;
    this.renderOcrHonorModal();
  }

  updateOcrSearchQuery(q) {
    this.ocrState.searchQuery = q || '';
    this.renderOcrOtherMembersList();
  }

  updateOcrMemberValueInput(memberId, val) {
    if (val === '' || val === null || val === undefined) {
      delete this.ocrState.manualEdits[memberId];
      return;
    }
    const num = Math.max(0, Number(val) || 0);
    if (this.ocrState.detectedMap[memberId]) {
      this.ocrState.detectedMap[memberId].value = num;
      this.ocrState.detectedMap[memberId].checked = true;
    } else {
      this.ocrState.manualEdits[memberId] = num;
    }
  }

  toggleOcrMemberChecked(memberId, checked) {
    if (this.ocrState.detectedMap[memberId]) {
      this.ocrState.detectedMap[memberId].checked = checked;
    }
  }

  applyOcrUpdates() {
    if (!this.isAdmin()) return;
    const mode = this.ocrState?.mode || 'honor';
    const now = new Date().toISOString();

    if (mode === 'members') {
      let addedCount = 0;
      let updatedCount = 0;
      const colors = ['#ff4500', '#ec4899', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6', '#06b6d4'];
      if (!this.state.members) this.state.members = [];

      for (const row of (this.ocrState.memberRows || [])) {
        if (!row.checked) continue;
        const nick = (row.nick || '').trim();
        const ffId = (row.ffId || '').trim();
        if (!nick && !ffId) continue;

        let target = ffId ? this.state.members.find(m => m.ffId === ffId) : null;
        if (!target && row.matchedMemberId) {
          target = this.state.members.find(m => m.id === row.matchedMemberId);
        }
        if (!target && nick) {
          target = this.findBestMemberMatchFromLine(nick);
        }

        if (target) {
          if (nick && target.nick !== nick) {
            target.previousNick = target.nick;
            target.nick = nick;
          }
          if (ffId && target.ffId !== ffId) {
            target.ffId = ffId;
          }
          target.updatedAt = now;
          updatedCount++;
        } else {
          this.state.members.unshift({
            id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
            nick: nick || `ID ${ffId}`,
            previousNick: '',
            ffId: ffId || '',
            password: '123',
            role: 'Integrante',
            gameRole: '🔥 Rusher',
            avatarColor: colors[this.state.members.length % colors.length],
            readyForWar: false,
            placas: this.getMinPlacasGuerra(),
            honor: this.getMinHonorKeep(),
            faltasBase: 0,
            semanasMas3kPrevias: 0,
            updatedAt: now
          });
          addedCount++;
        }
      }

      if (addedCount === 0 && updatedCount === 0) {
        this.showToast('⚠️ No hay cambios seleccionados para guardar');
        return;
      }

      this.closeOcrHonorModal();
      this.persistAndSync(`✅ ¡Listo! ${addedCount} agregado(s) y ${updatedCount} actualizado(s)`);
      return;
    }

    const field = mode === 'placas' ? 'placas' : 'honor';
    const statLabel = mode === 'placas' ? 'Placas de Guerra' : 'Honor';

    let updatedCount = 0;

    for (const m of (this.state.members || [])) {
      const detected = this.ocrState.detectedMap[m.id];
      const manual = this.ocrState.manualEdits[m.id];
      if (detected && detected.checked) {
        m[field] = Math.max(0, Number(detected.value) || 0);
        m.updatedAt = now;
        updatedCount++;
      } else if (manual !== undefined && manual !== null && manual !== '') {
        m[field] = Math.max(0, Number(manual) || 0);
        m.updatedAt = now;
        updatedCount++;
      }
    }

    if (updatedCount === 0) {
      this.showToast('⚠️ No hay cambios seleccionados para guardar');
      return;
    }

    this.closeOcrHonorModal();
    this.persistAndSync(`✅ ¡${statLabel} actualizado en ${updatedCount} integrante(s) desde tus capturas!`);
  }

  renderOcrOtherMembersList() {
    const listEl = document.getElementById('ocrOtherMembersList');
    if (!listEl) return;

    const st = this.ocrState || { mode: 'honor', detectedMap: {}, manualEdits: {}, searchQuery: '' };
    const field = st.mode === 'placas' ? 'placas' : 'honor';
    const members = this.state.members || [];
    const q = (st.searchQuery || '').trim().toLowerCase();
    const normQ = this.normalizeNickForMatch(q);

    const otherMembers = members.filter(m => {
      if (st.detectedMap[m.id]) return false;
      if (!q) return true;
      const matchRaw = m.nick.toLowerCase().includes(q) || (m.previousNick || '').toLowerCase().includes(q) || (m.ffId || '').toLowerCase().includes(q);
      const matchFancy = normQ && (this.normalizeNickForMatch(m.nick).includes(normQ) || this.normalizeNickForMatch(m.previousNick).includes(normQ));
      return matchRaw || matchFancy;
    });

    if (otherMembers.length === 0) {
      listEl.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted); padding:8px; text-align:center;">No se encontró ese integrante.</div>`;
      return;
    }

    listEl.innerHTML = otherMembers.map(m => {
      const currentVal = Number(m[field]) || 0;
      const val = st.manualEdits[m.id] !== undefined ? st.manualEdits[m.id] : '';
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--bg-input); padding:7px 10px; border-radius:10px;">
          <div style="min-width:0; flex:1;">
            <div style="font-weight:800; font-size:0.84rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(m.nick)}</div>
            <div style="font-size:0.7rem; color:var(--text-muted);">Actual: ${currentVal.toLocaleString()}</div>
          </div>
          <input type="number" min="0" placeholder="${currentVal}" class="form-input" style="width:105px; padding:6px 9px; text-align:right;" value="${val}" oninput="app.updateOcrMemberValueInput('${m.id}', this.value)" />
        </div>
      `;
    }).join('');
  }

  renderOcrHonorModal() {
    const body = document.getElementById('ocrHonorModalBody');
    if (!body) return;

    const st = this.ocrState || { mode: 'honor', images: [], selectedImageIdx: 0, detectedMap: {}, manualEdits: {}, memberRows: [], searchQuery: '', scanning: false, progressText: '' };
    const isPlacas = st.mode === 'placas';
    const isMembers = st.mode === 'members';
    const field = isPlacas ? 'placas' : 'honor';
    const statLabel = isPlacas ? 'Placas de Guerra' : isMembers ? 'IDs y Nombres' : 'Honor';

    const members = this.state.members || [];
    const detectedIds = Object.keys(st.detectedMap);
    const detectedMembers = members.filter(m => st.detectedMap[m.id]);
    const activeImg = st.images[st.selectedImageIdx];

    const previewSection = `
      <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:10px; line-height:1.4;">
        ${isMembers
          ? 'Sube 1 o varias capturas con los <strong>IDs y Nombres</strong>. Si no existe ni el ID ni el nombre, lo agrega; si ya estaba el ID o parte del nombre (sin símbolos), lo encuentra y actualiza.'
          : `Sube 1 o varias capturas de <strong>${statLabel}</strong>. La app reconoce los nombres (aunque tengan letras o fuentes diferentes) y detecta su número automáticamente mientras ves la captura.`}
      </p>

      <div class="form-group">
        <label class="btn ${isPlacas ? 'btn-purple' : isMembers ? 'btn-success' : 'btn-fire'} btn-block" style="cursor:pointer;">
          📤 Seleccionar Capturas de ${statLabel}
          <input type="file" accept="image/*" multiple style="display:none;" onchange="app.handleOcrScreenshotsSelected(event)" />
        </label>
      </div>

      ${st.progressText ? `
        <div id="ocrProgressLabel" style="font-size:0.8rem; font-weight:800; color:#fbbf24; background:rgba(251,191,36,0.12); padding:8px 10px; border-radius:10px; margin-bottom:10px;">
          ${this.escapeHtml(st.progressText)}
        </div>
      ` : ''}

      ${st.images.length > 0 ? `
        <div style="margin-bottom:12px;">
          ${st.images.length > 1 ? `
            <div style="display:flex; gap:6px; overflow-x:auto; margin-bottom:8px;">
              ${st.images.map((im, i) => `
                <button type="button" class="filter-btn ${i === st.selectedImageIdx ? 'active' : ''}" onclick="app.selectOcrPreviewImage(${i})">
                  Captura ${i + 1}
                </button>
              `).join('')}
            </div>
          ` : ''}
          ${activeImg ? `
            <div style="border:1px solid rgba(255,255,255,0.15); border-radius:12px; overflow:hidden; background:#000; max-height:260px; overflow-y:auto;">
              <img src="${activeImg.dataUrl}" alt="Captura" style="width:100%; display:block;" />
            </div>
          ` : ''}
        </div>
      ` : ''}
    `;

    if (isMembers) {
      const rows = st.memberRows || [];
      body.innerHTML = `
        ${previewSection}

        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-size:0.82rem; font-weight:900; color:#4ade80;">
            🆔 Detectados / Por agregar (${rows.length}):
          </span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.addManualOcrMemberRow()">
            ➕ Agregar viendo captura
          </button>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px; max-height:290px; overflow-y:auto; margin-bottom:14px;">
          ${rows.length === 0 ? `
            <div style="font-size:0.8rem; color:var(--text-muted); text-align:center; padding:12px; background:var(--bg-input); border-radius:10px;">
              Sube una captura o toca "➕ Agregar viendo captura" para capturar un Nick e ID.
            </div>
          ` : rows.map(r => {
            const isUpdate = Boolean(r.matchedMemberId);
            const badgeText = isUpdate
              ? `🔄 Actualizar a: ${r.matchedOldNick} (${r.matchedOldId || 'sin ID'})`
              : '➕ Nuevo integrante';
            return `
              <div style="background:${isUpdate ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)'}; border:1px solid ${isUpdate ? 'rgba(245,158,11,0.35)' : 'rgba(34,197,94,0.35)'}; padding:9px 10px; border-radius:10px;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
                  <label style="display:flex; align-items:center; gap:6px; font-size:0.74rem; font-weight:900; color:${isUpdate ? '#fbbf24' : '#4ade80'}; cursor:pointer;">
                    <input type="checkbox" ${r.checked ? 'checked' : ''} onchange="app.toggleOcrMemberRowChecked('${r.rowId}', this.checked)" />
                    <span id="ocrRowBadge-${r.rowId}">${this.escapeHtml(badgeText)}</span>
                  </label>
                </div>
                <div style="display:grid; grid-template-columns:1.2fr 1fr; gap:6px;">
                  <input type="text" class="form-input" style="padding:7px 9px; font-size:0.84rem;" placeholder="Nick de Free Fire" value="${this.escapeHtml(r.nick)}" oninput="app.updateOcrMemberRowField('${r.rowId}', 'nick', this.value)" />
                  <input type="text" class="form-input" style="padding:7px 9px; font-size:0.84rem;" placeholder="ID de Free Fire" value="${this.escapeHtml(r.ffId)}" oninput="app.updateOcrMemberRowField('${r.rowId}', 'ffId', this.value)" />
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-secondary btn-block" onclick="app.closeOcrHonorModal()">Cancelar</button>
          <button type="button" class="btn btn-success btn-block" onclick="app.applyOcrUpdates()">💾 Guardar y Agregar</button>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      ${previewSection}

      ${detectedMembers.length > 0 ? `
        <div style="font-size:0.82rem; font-weight:900; color:#4ade80; margin-bottom:6px;">
          ✅ Detectados automáticamente (${detectedMembers.length}):
        </div>
        <div style="display:flex; flex-direction:column; gap:7px; margin-bottom:14px;">
          ${detectedMembers.map(m => {
            const det = st.detectedMap[m.id];
            const currentVal = Number(m[field]) || 0;
            return `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.35); padding:8px 10px; border-radius:10px;">
                <label style="display:flex; align-items:center; gap:8px; min-width:0; flex:1; cursor:pointer;">
                  <input type="checkbox" ${det.checked ? 'checked' : ''} onchange="app.toggleOcrMemberChecked('${m.id}', this.checked)" />
                  <div style="min-width:0;">
                    <div style="font-weight:800; font-size:0.86rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(m.nick)}</div>
                    <div style="font-size:0.72rem; color:var(--text-muted);">Actual: ${currentVal.toLocaleString()}</div>
                  </div>
                </label>
                <input type="number" min="0" class="form-input" style="width:105px; padding:7px 9px; font-weight:900; text-align:right;" value="${det.value}" oninput="app.updateOcrMemberValueInput('${m.id}', this.value)" />
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      <div style="font-size:0.82rem; font-weight:900; color:var(--text-muted); margin-bottom:6px;">
        📋 ${detectedIds.length > 0 ? 'Buscar o completar otros integrantes:' : 'Buscar integrante (escribe su nombre viendo tu captura):'}
      </div>
      <div style="margin-bottom:8px;">
        <input type="text" class="form-input" style="padding:9px 11px; font-size:0.86rem;" placeholder="🔍 Buscar por nombre (ej. yuna, tucan, id)..." value="${this.escapeHtml(st.searchQuery || '')}" oninput="app.updateOcrSearchQuery(this.value)" />
      </div>
      <div id="ocrOtherMembersList" style="display:flex; flex-direction:column; gap:6px; max-height:220px; overflow-y:auto; margin-bottom:14px;"></div>

      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-secondary btn-block" onclick="app.closeOcrHonorModal()">Cancelar</button>
        <button type="button" class="btn btn-success btn-block" onclick="app.applyOcrUpdates()">💾 Guardar ${statLabel}</button>
      </div>
    `;

    this.renderOcrOtherMembersList();
  }

  openSyncModal() {
    const modal = document.getElementById('syncModal');
    const body = document.getElementById('syncModalBody');
    if (!modal || !body) return;

    const globalUrl = this.permanentAppUrl || this.serverInfo?.publicUrl || '';
    const lanUrls = this.serverInfo?.urls?.length ? this.serverInfo.urls : [window.location.origin];
    const primaryUrl = globalUrl || lanUrls[0];

    body.innerHTML = `
      <p style="font-size:0.84rem; color:var(--text-muted); margin-bottom:10px;">
        Comparte este link en el grupo <strong>Integrantes</strong> de <strong>⚔️ 𝐃𝐄𝐀𝐓𝐇𝐋𝐈𝐌𝐈𝐓𝐄 | Clan</strong>:
      </p>
      <div style="background:var(--bg-input); padding:12px; border-radius:12px; font-weight:800; font-size:0.86rem; word-break:break-all; margin-bottom:12px;">
        ${this.escapeHtml(primaryUrl)}
      </div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <button type="button" class="btn btn-success btn-block" onclick="app.shareAppLinkToWhatsApp('${this.escapeHtml(primaryUrl)}')">
          📲 Compartir Link de la App en WhatsApp
        </button>
        <button type="button" class="btn btn-fire btn-block" onclick="app.triggerInstallApp()">
          📲 Instalar en mi Celular
        </button>
      </div>
    `;
    modal.classList.remove('hidden');
  }

  closeSyncModal() {
    document.getElementById('syncModal').classList.add('hidden');
  }

  async triggerInstallApp() {
    if (this.deferredInstallPrompt) {
      this.deferredInstallPrompt.prompt();
      await this.deferredInstallPrompt.userChoice;
      this.deferredInstallPrompt = null;
    } else {
      this.showToast('📲 En tu celular toca el menú (⋮) de Chrome y elige "Instalar aplicación"');
    }
  }

  showToast(msg) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

const app = new FFClanApp();
window.addEventListener('DOMContentLoaded', () => app.init());
