/* global __ENV, console */

import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import encoding from "k6/encoding";
import { Counter, Trend } from "k6/metrics";

const DEFAULT_STAGE_SECONDS = 30;
const DEFAULT_WARMUP_SECONDS = 10;
const DEFAULT_MAX_VUS = 16;
const DEFAULT_PROPFIND_FILES = 1000;
const STAGE_LEVELS = [1, 2, 4, 8, 16];
const READ_SIZE = 4 * 1024;
const BATCH_SIZE = 50;

const baseUrl = normalizeBaseUrl(__ENV.WEBDAV_URL);
const username = requireEnv("WEBDAV_USERNAME");
const password = requireEnv("WEBDAV_PASSWORD");
const cleanupPrefix = __ENV.PERF_CLEANUP_PREFIX;
const stageSeconds = positiveInteger(
  __ENV.PERF_STAGE_SECONDS,
  DEFAULT_STAGE_SECONDS,
  "PERF_STAGE_SECONDS",
);
const warmupSeconds = positiveInteger(
  __ENV.PERF_WARMUP_SECONDS,
  DEFAULT_WARMUP_SECONDS,
  "PERF_WARMUP_SECONDS",
);
const maxVus = positiveInteger(
  __ENV.PERF_MAX_VUS,
  DEFAULT_MAX_VUS,
  "PERF_MAX_VUS",
);
const propfindFiles = positiveInteger(
  __ENV.PERF_PROPFIND_FILES,
  DEFAULT_PROPFIND_FILES,
  "PERF_PROPFIND_FILES",
);

if (cleanupPrefix && !validPrefix(cleanupPrefix)) {
  throw new Error(
    "PERF_CLEANUP_PREFIX must contain only letters, numbers, dots, underscores, or hyphens.",
  );
}

const levels = STAGE_LEVELS.filter((level) => level <= maxVus);
if (levels[levels.length - 1] !== maxVus) levels.push(maxVus);
const scenarioDurationSeconds =
  levels.length * (warmupSeconds + stageSeconds) + 1;

const successfulOperations = new Counter("webdav_successful_operations");
const failedOperations = new Counter("webdav_failed_operations");
const timeouts = new Counter("webdav_timeouts");
const serverErrors = new Counter("webdav_5xx_responses");
const unexpectedClientErrors = new Counter("webdav_unexpected_4xx_responses");
const propfindResponseBytes = new Trend("webdav_propfind_response_bytes");
const propfindCompletion = new Trend("webdav_propfind_completion_ms");
const summaryTrendStats = [
  "avg",
  "min",
  "p(50)",
  "p(90)",
  "p(95)",
  "p(99)",
  "p(99.9)",
  "max",
];

export const options = cleanupPrefix
  ? {
      setupTimeout: "10m",
      teardownTimeout: "5m",
      summaryTrendStats,
      scenarios: {
        cleanup: {
          executor: "per-vu-iterations",
          vus: 1,
          iterations: 1,
          exec: "runCleanup",
        },
      },
      thresholds: {
        checks: ["rate==1"],
      },
    }
  : {
      setupTimeout: "10m",
      teardownTimeout: "5m",
      summaryTrendStats,
      scenarios: buildScenarios(),
      thresholds: {
        checks: ["rate>0.99"],
      },
    };

export function setup() {
  const prefix = cleanupPrefix
    ? cleanupPrefix
    : `perf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  console.log(`WebDAV performance prefix: ${prefix}`);

  const data = {
    baseUrl,
    prefix,
    scenario: cleanupPrefix ? "cleanup" : "all",
    propfindFiles,
  };
  if (cleanupPrefix) return data;

  const root = request(data, "MKCOL", prefix, null, "setup", "0B");
  assertStatus(root, 201, `create ${prefix}`);

  createPutFixture(data);
  createPropfindFixture(data);
  createReadFixture(data);

  return data;
}

export function runPut(data) {
  const iteration = exec.vu.iterationInInstance;
  const size = iteration % 2 === 0 ? "0B" : "4KiB";
  const body = size === "0B" ? "" : payload(READ_SIZE);
  const path = `${data.prefix}/put/vu-${exec.vu.idInTest}-${iteration}-${Date.now()}`;
  const response = request(data, "PUT", path, body, "measurement", size);
  recordResponse(response, tags(data, "PUT", size));
  check(response, {
    "PUT creates a resource": (value) => value.status === 201,
  });
}

export function runPropfind(data) {
  const response = request(
    data,
    "PROPFIND",
    `${data.prefix}/propfind`,
    null,
    undefined,
    "0B",
    { Depth: "1" },
  );
  const requestTags = tags(data, "PROPFIND", "0B");
  recordResponse(response, requestTags);
  const body = response.body || "";
  propfindResponseBytes.add(body.length, requestTags);
  propfindCompletion.add(response.timings.duration, requestTags);
  check(response, {
    "PROPFIND returns 207": (value) => value.status === 207,
    "PROPFIND returns a directory listing": (value) =>
      Boolean(value.body && value.body.includes("propfind/fixture-")),
  });
}

export function runGet(data) {
  const response = request(
    data,
    "GET",
    `${data.prefix}/read-fixture.bin`,
    null,
    undefined,
    "4KiB",
  );
  const requestTags = tags(data, "GET", "4KiB");
  recordResponse(response, requestTags);
  check(response, {
    "GET returns 200": (value) => value.status === 200,
    "GET returns 4 KiB": (value) => (value.body || "").length === READ_SIZE,
  });
}

export function runHead(data) {
  const response = request(
    data,
    "HEAD",
    `${data.prefix}/read-fixture.bin`,
    null,
    undefined,
    "4KiB",
  );
  const requestTags = tags(data, "HEAD", "4KiB");
  recordResponse(response, requestTags);
  check(response, {
    "HEAD returns 200": (value) => value.status === 200,
    "HEAD returns metadata without a body": (value) =>
      !value.body && value.headers["Content-Length"] === String(READ_SIZE),
  });
}

export function runCleanup(data) {
  const response = request(data, "DELETE", data.prefix, null, "cleanup", "0B");
  recordResponse(response, {
    scenario: "cleanup",
    method: "DELETE",
    phase: "cleanup",
    concurrency: "cleanup",
    size: "0B",
  });
  check(response, {
    "cleanup deletes the performance prefix": (value) => value.status === 204,
  });
}

export function teardown(data) {
  if (cleanupPrefix) return;
  const response = request(data, "DELETE", data.prefix, null, "cleanup", "0B");
  assertStatus(response, 204, `delete ${data.prefix}`);
  console.log(`WebDAV performance prefix cleaned: ${data.prefix}`);
}

function buildScenarios() {
  const scenarios = {};
  let startTime = 0;
  for (const name of ["put", "propfind", "get", "head"]) {
    scenarios[name] = {
      executor: "ramping-vus",
      startTime: `${startTime}s`,
      startVUs: 0,
      stages: stages(),
      gracefulRampDown: "1s",
      exec: `run${name[0].toUpperCase()}${name.slice(1)}`,
    };
    startTime += scenarioDurationSeconds + 1;
  }
  return scenarios;
}

function stages() {
  const result = [];
  for (const level of levels) {
    result.push({ duration: `${warmupSeconds}s`, target: level });
    result.push({ duration: `${stageSeconds}s`, target: level });
  }
  result.push({ duration: "1s", target: 0 });
  return result;
}

function createPropfindFixture(data) {
  const collection = request(
    data,
    "MKCOL",
    `${data.prefix}/propfind`,
    null,
    "setup",
    "0B",
  );
  assertStatus(collection, 201, "create PROPFIND fixture collection");

  for (let offset = 0; offset < data.propfindFiles; offset += BATCH_SIZE) {
    const batch = [];
    const end = Math.min(offset + BATCH_SIZE, data.propfindFiles);
    for (let index = offset; index < end; index++) {
      batch.push({
        method: "PUT",
        url: url(data, `${data.prefix}/propfind/fixture-${index}`),
        body: "",
        params: params(data, "PUT", "0B", "setup"),
      });
    }
    const responses = http.batch(batch);
    for (const [index, response] of responses.entries())
      assertStatus(response, 201, `create PROPFIND fixture ${offset + index}`);
    console.log(`PROPFIND fixture setup: ${end}/${data.propfindFiles}`);
  }
}

function createPutFixture(data) {
  const collection = request(
    data,
    "MKCOL",
    `${data.prefix}/put`,
    null,
    "setup",
    "0B",
  );
  assertStatus(collection, 201, "create PUT fixture collection");
}

function createReadFixture(data) {
  const response = request(
    data,
    "PUT",
    `${data.prefix}/read-fixture.bin`,
    payload(READ_SIZE),
    "setup",
    "4KiB",
  );
  assertStatus(response, 201, "create read fixture");
}

function request(data, method, path, body, phase, size, extraHeaders = {}) {
  return http.request(
    method,
    url(data, path),
    body,
    params(data, method, size, phase, extraHeaders),
  );
}

function params(data, method, size, phase, extraHeaders = {}) {
  return {
    headers: {
      Authorization: `Basic ${encoding.b64encode(`${username}:${password}`)}`,
      "User-Agent": "k6-webdav-perf/1.0",
      ...extraHeaders,
    },
    tags:
      phase === "setup" || phase === "cleanup"
        ? {
            scenario: data.scenario,
            method,
            phase,
            concurrency: phase,
            size,
          }
        : tags(data, method, size),
  };
}

function tags(data, method, size) {
  const elapsed = (Date.now() - Number(exec.scenario.startTime)) / 1000;
  const blockSeconds = warmupSeconds + stageSeconds;
  const block = Math.min(
    Math.max(Math.floor(Math.max(0, elapsed) / blockSeconds), 0),
    levels.length - 1,
  );
  const withinBlock = Math.max(0, elapsed - block * blockSeconds);
  return {
    scenario: exec.scenario.name || data.scenario,
    method,
    phase: withinBlock < warmupSeconds ? "warmup" : "measurement",
    concurrency: String(exec.instance.vusActive),
    size,
  };
}

function recordResponse(response, requestTags) {
  const success = response.status >= 200 && response.status < 300;
  if (success) successfulOperations.add(1, requestTags);
  else failedOperations.add(1, requestTags);
  if (response.status >= 500) serverErrors.add(1, requestTags);
  if (response.status >= 400 && response.status < 500)
    unexpectedClientErrors.add(1, requestTags);
  if (response.status === 0 || /timeout/i.test(response.error || ""))
    timeouts.add(1, requestTags);
}

function assertStatus(response, expected, operation) {
  if (response.status !== expected)
    throw new Error(
      `${operation} failed with HTTP ${response.status}: ${response.error || ""}`,
    );
}

function url(data, path) {
  return `${data.baseUrl}/${path}`;
}

function payload(size) {
  return "x".repeat(size);
}

function requireEnv(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeBaseUrl(value) {
  if (!value) throw new Error("WEBDAV_URL is required");
  if (!/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(value))
    throw new Error(
      "WEBDAV_URL must be an absolute HTTP or HTTPS URL without query or hash",
    );
  return value.replace(/\/+$/, "");
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function validPrefix(value) {
  return Boolean(value && /^[A-Za-z0-9._-]+$/.test(value));
}
