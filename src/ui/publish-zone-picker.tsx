"use client";

import { useEffect, useState } from "react";
import { defaultPublishZone, normalizePublishZone, publishZones, type PublishZone } from "@/lib/publish-time";

export function usePublishZone() {
  const [zone, setZone] = useState<PublishZone>(defaultPublishZone);
  useEffect(() => {
    try { setZone(normalizePublishZone(localStorage.getItem("publisher.time-zone"))); } catch {}
  }, []);
  return [zone, (value: PublishZone) => {
    setZone(value);
    try { localStorage.setItem("publisher.time-zone", value); } catch {}
  }] as const;
}

export function PublishZonePicker({ zone, setZone }: { zone: PublishZone; setZone: (value: PublishZone) => void }) {
  return <label className="form-field"><span>时区</span>
    <select value={zone} onChange={event => setZone(normalizePublishZone(event.target.value))}>
      {Object.entries(publishZones).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
    </select>
  </label>;
}
