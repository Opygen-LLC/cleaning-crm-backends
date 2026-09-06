/* Atomic Redis command model for the Lua scripts used by the source.
 * Real Lua/Redis and multi-process tests remain a staging release gate.
 */
class MemoryRedis {
  constructor(now = () => Date.now()) { this.now = now; this.values = new Map(); this.writes = []; this.down = false; this.failProjectionWrites = false; }
  check() { if (this.down) throw new Error('TEST_REDIS_UNAVAILABLE'); }
  raw(key) { const row = this.values.get(key); if (row && row.until !== null && row.until <= this.now()) { this.values.delete(key); return null; } return row?.value ?? null; }
  put(key, value, ms = null) { this.values.set(key, { value: String(value), until: ms === null ? null : this.now() + ms }); this.writes.push({ key, value: String(value), ttlMs: ms, at: this.now() }); }
  async get(key) { this.check(); return this.raw(key); }
  async set(key, value, ...args) { this.check(); const nx = args.includes('NX'); if (nx && this.raw(key) !== null) return null; const px = args.indexOf('PX'), ex = args.indexOf('EX'); const ms = px >= 0 ? Number(args[px+1]) : ex >= 0 ? Number(args[ex+1])*1000 : null; this.put(key,value,ms); return 'OK'; }
  async setex(key, seconds, value) { return this.set(key, value, 'EX', seconds); }
  async del(...keys) { this.check(); return keys.reduce((n,k) => n + Number(this.values.delete(k)), 0); }
  async eval(script, count, ...args) {
    this.check(); const keys = args.slice(0,count), argv = args.slice(count).map(String);
    if (script.trim().startsWith('return {')) return [this.raw(keys[0]), this.raw(keys[1]) ?? '0'];
    const incr = script.match(/'INCR',\s*KEYS\[(\d+)\]/);
    if (incr) {
      const k = keys[Number(incr[1])-1]; this.put(k, String(Number(this.raw(k) || 0)+1));
      const del = script.match(/'DEL',([^)]*)\)/);
      for (const m of (del?.[1] ?? '').matchAll(/KEYS\[(\d+)\]/g)) this.values.delete(keys[Number(m[1])-1]);
      return 1;
    }
    if (script.includes("'SET'")) {
      const guard = count === 3 && script.includes("KEYS[3])") && !script.includes('ARGV[4] ~=') ? 2 : 1;
      if ((this.raw(keys[guard]) ?? '0') !== argv[0]) return 0;
      if (script.includes('ARGV[4] ~=') && argv[3] && (this.raw(keys[2]) ?? '0') !== argv[3]) return 0;
      if (this.failProjectionWrites && keys[0].startsWith('website-projection:')) throw new Error('TEST_REDIS_WRITE_FAILED');
      if (!(Number(argv[2]) > 0)) throw new Error('Invalid Redis expiry');
      this.put(keys[0],argv[1],Number(argv[2]));
      if (guard === 2) this.put(keys[1],argv[1],Number(argv[3]));
      return 1;
    }
    if (script.includes("'DEL'") && script.includes('ARGV[1]')) {
      if (this.raw(keys[0]) === argv[0]) { this.values.delete(keys[0]); return 1; } return 0;
    }
    throw new Error(`Unsupported Lua command model: ${script}`);
  }
}
module.exports = { MemoryRedis };
