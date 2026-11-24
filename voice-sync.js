"use strict";

function isValidActorVoiceId(value) {
  return typeof value === "string" && value.length <= 256 && value.trim().length > 0 &&
    !/[\p{Cc}\p{Surrogate}]/u.test(value);
}

function createActorVoiceSync(validIds, onChange) {
  const config = window.actorVoiceSync;
  const client = config?.url && config?.publishableKey && window.supabase?.createClient(
    config.url,
    config.publishableKey,
    { auth: { storageKey: "gigamakyeo-actor-auth-v1", flowType: "pkce" } },
  );
  const table = "actor_voice_assignments";
  const storagePrefix = "gigamakyeo-actors-sync-v1:";
  const pollInterval = 8000;
  const requestTimeout = 15000;
  let current = null;
  let authReady = !client;

  function openLocalStorage(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function parsePending(value) {
    return value && typeof value.token === "string" && Number.isFinite(value.createdAt) &&
      (value.voice === null || isValidActorVoiceId(value.voice))
      ? value : null;
  }

  function readPending(connection) {
    const pending = new Map();
    function add(id, entry) {
      if (connection.acknowledged.has(entry.token)) {
        return;
      }
      const work = pending.get(id);
      if (!work) {
        pending.set(id, { latest: entry, tokens: [entry.token] });
        return;
      }
      work.tokens.push(entry.token);
      const samePriority = entry.keepExisting === work.latest.keepExisting;
      const explicitEdit = !entry.keepExisting && work.latest.keepExisting;
      const newer = entry.createdAt > work.latest.createdAt ||
        (entry.createdAt === work.latest.createdAt && entry.token > work.latest.token);
      if (explicitEdit || (samePriority && newer)) {
        work.latest = entry;
      }
    }
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith(connection.pendingPrefix)) {
          continue;
        }
        const [id, token] = key.slice(connection.pendingPrefix.length).split(":");
        const entry = validIds.has(id) && parsePending(openLocalStorage(key));
        if (entry && entry.token === token) {
          add(id, entry);
        }
      }
    } catch {
      // Online writes still work if the browser disallows local persistence.
    }
    for (const [id, entry] of connection.volatile) {
      add(id, entry);
    }
    return pending;
  }

  function emit() {
    const assignments = new Map();
    const knownIds = new Set();
    let phase = "config";
    if (client) {
      phase = authReady ? "signed-out" : "loading";
    }
    if (current) {
      phase = "loading";
      if (!navigator.onLine) {
        phase = "offline";
      } else if (current.readFailed || current.writeFailed) {
        phase = "failed";
      } else if (current.pending.size) {
        phase = "saving";
      } else if (current.synced) {
        phase = "saved";
      }
      for (const [id, voice] of current.remote) {
        knownIds.add(id);
        if (voice !== null) {
          assignments.set(id, voice);
        }
      }
      for (const [id, { latest: entry }] of current.pending) {
        knownIds.add(id);
        if (entry.voice === null) {
          assignments.delete(id);
        } else {
          assignments.set(id, entry.voice);
        }
      }
    }
    onChange({
      phase,
      user: current?.user || null,
      canEdit: !!(current?.synced || current?.hasCache),
      canMigrate: !!current?.synced,
      assignments,
      knownIds,
      pendingCount: current?.pending.size || 0,
      volatileCount: current?.volatile.size || 0,
    });
  }

  function cacheRemote(connection) {
    try {
      localStorage.setItem(connection.cacheKey, JSON.stringify(Object.fromEntries(connection.remote)));
    } catch {
      // The server copy is authoritative. Pending saves are tracked separately.
    }
  }

  async function refresh(connection) {
    if (connection !== current || !navigator.onLine) {
      return;
    }
    if (connection.refreshing) {
      connection.refreshAgain = true;
      return;
    }
    connection.refreshing = true;
    const startedAtRevision = connection.writeRevision;
    try {
      const incoming = new Map();
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client.from(table)
          .select("actor_id,voice_id")
          .eq("user_id", connection.user.id)
          .order("actor_id")
          .range(offset, offset + pageSize - 1)
          .abortSignal(AbortSignal.timeout(requestTimeout));
        if (connection !== current) {
          return;
        }
        if (error) {
          throw error;
        }
        for (const row of data) {
          if (validIds.has(row.actor_id)) {
            incoming.set(row.actor_id, row.voice_id);
          }
        }
        if (data.length < pageSize) {
          break;
        }
      }
      if (startedAtRevision === connection.writeRevision) {
        connection.remote = incoming;
        connection.synced = true;
        connection.hasCache = true;
        connection.readFailed = false;
        cacheRemote(connection);
      } else {
        connection.refreshAgain = true;
      }
    } catch {
      connection.readFailed = true;
    } finally {
      connection.refreshing = false;
      if (connection === current) {
        emit();
        if (connection.refreshAgain) {
          connection.refreshAgain = false;
          scheduleRefresh(connection);
        }
      }
    }
  }

  function scheduleRefresh(connection) {
    if (connection === current && !connection.refreshTimer) {
      connection.refreshTimer = setTimeout(() => {
        connection.refreshTimer = null;
        void refresh(connection);
      }, 100);
    }
  }

  function clearAcknowledged(connection, id, { tokens }) {
    for (const token of tokens) {
      try {
        localStorage.removeItem(`${connection.pendingPrefix}${id}:${token}`);
      } catch {
        connection.acknowledged.add(token);
      }
      if (connection.volatile.get(id)?.token === token) {
        connection.volatile.delete(id);
      }
    }
  }

  async function flush(connection) {
    if (connection !== current || connection.flushing || !navigator.onLine || !connection.pending.size) {
      return;
    }
    connection.flushing = true;
    connection.writeFailed = false;
    emit();
    const drain = async () => {
      while (connection === current && navigator.onLine) {
        connection.pending = readPending(connection);
        const first = connection.pending.values().next().value?.latest;
        if (!first) {
          return;
        }
        const batch = [...connection.pending]
          .filter(([, work]) => work.latest.keepExisting === first.keepExisting)
          .slice(0, 50);
        const records = batch.map(([id, { latest: entry }]) => ({
          user_id: connection.user.id,
          actor_id: id,
          voice_id: entry.voice,
        }));
        const { data, error } = await client.from(table).upsert(records, {
          onConflict: "user_id,actor_id",
          ignoreDuplicates: first.keepExisting === true,
        }).select("actor_id,voice_id").abortSignal(AbortSignal.timeout(requestTimeout));
        if (error) {
          throw error;
        }
        for (const [id, work] of batch) {
          clearAcknowledged(connection, id, work);
        }
        if (connection === current) {
          connection.writeRevision += 1;
          for (const row of data) {
            connection.remote.set(row.actor_id, row.voice_id);
          }
          connection.pending = readPending(connection);
          cacheRemote(connection);
          scheduleRefresh(connection);
          emit();
        }
      }
    };
    try {
      if (navigator.locks) {
        await navigator.locks.request(connection.pendingPrefix, drain);
      } else {
        await drain();
      }
    } catch {
      connection.writeFailed = true;
    } finally {
      connection.flushing = false;
      if (connection === current) {
        emit();
      }
    }
  }

  function queue(changes, { keepExisting = false } = {}) {
    if (!current || (!current.synced && !current.hasCache)) {
      return false;
    }
    const validated = [...changes];
    if (validated.some(([id, voice]) => !validIds.has(id) || (voice !== null && !isValidActorVoiceId(voice)))) {
      return false;
    }
    for (const [id, voice] of validated) {
      const timestamp = performance.timeOrigin + performance.now();
      const createdAt = Math.max(timestamp, current.lastQueuedAt + 0.001);
      current.lastQueuedAt = createdAt;
      const entry = { voice, token: crypto.randomUUID(), createdAt, keepExisting };
      try {
        localStorage.setItem(`${current.pendingPrefix}${id}:${entry.token}`, JSON.stringify(entry));
        current.volatile.delete(id);
      } catch {
        current.volatile.set(id, entry);
      }
    }
    current.pending = readPending(current);
    if (current.pending.size) {
      emit();
      void flush(current);
    }
    return true;
  }

  function synchronize() {
    if (current) {
      current.pending = readPending(current);
      void refresh(current);
      void flush(current);
    }
    emit();
  }

  function useSession(session) {
    authReady = true;
    const user = session?.user;
    if (user?.id === current?.user.id) {
      emit();
      return;
    }
    if (current) {
      clearTimeout(current.refreshTimer);
      void client.removeChannel(current.channel);
    }
    current = null;
    if (!user) {
      emit();
      return;
    }

    const prefix = storagePrefix + user.id + ":";
    const cached = openLocalStorage(prefix + "snapshot");
    const remote = new Map(Object.entries(cached || {}).filter(([id, voice]) =>
      validIds.has(id) && (voice === null || isValidActorVoiceId(voice))));
    const connection = {
      user,
      cacheKey: prefix + "snapshot",
      pendingPrefix: prefix + "pending:",
      hasCache: cached !== null,
      synced: false,
      remote,
      volatile: new Map(),
      acknowledged: new Set(),
      writeRevision: 0,
      lastQueuedAt: 0,
    };
    connection.pending = readPending(connection);
    current = connection;
    const changes = { schema: "public", table, filter: `user_id=eq.${user.id}` };
    connection.channel = client.channel(`actor-voices:${user.id}`)
      .on("postgres_changes", { ...changes, event: "INSERT" }, () => scheduleRefresh(connection))
      .on("postgres_changes", { ...changes, event: "UPDATE" }, () => scheduleRefresh(connection))
      .subscribe((state) => {
        connection.realtimeConnected = state === "SUBSCRIBED";
        if (connection.realtimeConnected) {
          scheduleRefresh(connection);
        }
      });
    synchronize();
  }

  function start() {
    emit();
    if (!client) {
      return;
    }
    client.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => useSession(session), 0);
    });
    window.addEventListener("online", synchronize);
    window.addEventListener("offline", emit);
    window.addEventListener("focus", synchronize);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        synchronize();
      }
    });
    window.addEventListener("storage", (event) => {
      if (current && event.key?.startsWith(current.pendingPrefix)) {
        current.pending = readPending(current);
        synchronize();
      }
    });
    setInterval(() => {
      if (current && !document.hidden &&
          (!current.realtimeConnected || current.pending.size || current.readFailed || current.writeFailed)) {
        synchronize();
      }
    }, pollInterval);
  }

  return {
    start,
    queue,
    retry: synchronize,
    signIn: (email, password) => client.auth.signInWithPassword({ email, password }),
    signUp: (email, password) => client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: config.siteUrl || new URL(".", location.href).href },
    }),
    signOut: () => client.auth.signOut({ scope: "local" }),
  };
}
