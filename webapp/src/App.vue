<script setup lang="ts">
import { onMounted, ref } from "vue";

import { fetchMe, fetchStatus, kvRoundTrip, logout, type Me } from "./lib/api";

const loading = ref(true);
const error = ref<string | null>(null);
const drivers = ref<string[]>([]);
const me = ref<Me | null>(null);

const kvKey = ref("greeting");
const kvValue = ref("hello from the browser");
const kvResult = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const status = await fetchStatus();
    drivers.value = status.drivers;
    me.value = status.authenticated ? await fetchMe() : null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function onLogout() {
  await logout();
  me.value = null;
  await load();
}

async function onKvDemo() {
  const { readBack } = await kvRoundTrip(kvKey.value, kvValue.value);
  kvResult.value = readBack;
}

onMounted(load);
</script>

<template>
  <main class="shell">
    <h1>enrahitu</h1>
    <p class="tagline">Encore.ts + rauthy + hiqlite (+ Turso), one container.</p>

    <p v-if="loading">loading...</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <section v-else-if="!me" class="card">
      <h2>Sign in</h2>
      <ul class="drivers">
        <li v-if="drivers.includes('mock')">
          <a class="button" href="/api/v1/auth/mock/login?user=0">Mock: Casey User</a>
          <a class="button" href="/api/v1/auth/mock/login?user=1">Mock: Avery Admin</a>
        </li>
        <li v-if="drivers.includes('rauthy')">
          <a class="button primary" href="/api/v1/auth/rauthy/login">Sign in with rauthy</a>
        </li>
      </ul>
      <p class="hint">drivers configured: {{ drivers.join(", ") || "none" }}</p>
    </section>

    <section v-else class="card">
      <h2>Signed in</h2>
      <dl>
        <dt>name</dt>
        <dd>{{ me.name }}</dd>
        <dt>email</dt>
        <dd>{{ me.email }}</dd>
        <dt>roles</dt>
        <dd>{{ me.roles.join(", ") }}</dd>
        <dt>provider</dt>
        <dd>{{ me.ssoProvider }}</dd>
        <dt>last login</dt>
        <dd>{{ me.lastLoginAt ?? "n/a" }}</dd>
      </dl>
      <button class="button" @click="onLogout">Sign out</button>

      <h3>hiqlite cache demo</h3>
      <div class="kv">
        <input v-model="kvKey" placeholder="key" />
        <input v-model="kvValue" placeholder="value" />
        <button class="button" @click="onKvDemo">put + get</button>
      </div>
      <p v-if="kvResult !== null" class="hint">read back: "{{ kvResult }}"</p>
    </section>
  </main>
</template>

<style>
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}
body {
  margin: 0;
  display: grid;
  place-items: start center;
  min-height: 100vh;
}
.shell {
  max-width: 40rem;
  padding: 3rem 1.5rem;
}
.tagline {
  opacity: 0.7;
}
.card {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-top: 1.5rem;
}
.drivers {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}
.button {
  display: inline-block;
  border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  border-radius: 0.5rem;
  padding: 0.5rem 1rem;
  margin-right: 0.5rem;
  text-decoration: none;
  color: inherit;
  background: none;
  font: inherit;
  cursor: pointer;
}
.button.primary {
  border-color: #7c5cff;
  color: #7c5cff;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
}
dt {
  opacity: 0.6;
}
dd {
  margin: 0;
}
.kv {
  display: flex;
  gap: 0.5rem;
}
.kv input {
  padding: 0.4rem 0.6rem;
  border-radius: 0.4rem;
  border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  background: none;
  color: inherit;
}
.error {
  color: #e5484d;
}
.hint {
  opacity: 0.7;
  font-size: 0.9rem;
}
</style>
