import { useState } from "react";

import { kvRoundTrip } from "../lib/api";

// hiqlite cache demo widget (spec 015 §3): put a value then read it straight
// back through the embedded cache (60s TTL). Local component state, no loader.
export default function KvDemo() {
  const [key, setKey] = useState("greeting");
  const [value, setValue] = useState("hello from the browser");
  const [result, setResult] = useState<string | null>(null);

  async function onDemo() {
    const { readBack } = await kvRoundTrip(key, value);
    setResult(readBack);
  }

  return (
    <>
      <div className="kv">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="key" />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
        <button className="button" type="button" onClick={onDemo}>
          put + get
        </button>
      </div>
      {result !== null && <p className="hint">read back: "{result}"</p>}
    </>
  );
}
