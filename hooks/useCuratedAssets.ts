"use client";

import { useEffect, useMemo, useState } from "react";
import { createAssetLoader, type AssetLoadResult, type ReadyAsset } from "@/lib/assets/loader";
import { getCuratedAsset } from "@/lib/assets/registry";

export function useCuratedAssets(sceneId: string | null, materialId: string | null) {
  const key = JSON.stringify([sceneId, materialId]);
  const [loaded, setLoaded] = useState<{ key: string; results: AssetLoadResult[] } | null>(null);
  const ids = useMemo(() => [...new Set([sceneId, materialId].filter((id): id is string => Boolean(id && getCuratedAsset(id))))], [sceneId, materialId]);
  useEffect(() => {
    const loader = createAssetLoader();
    let active = true;
    void Promise.all(ids.map(id => loader.preload(id))).then(results => {
      if (active) setLoaded({ key, results });
    });
    return () => { active = false; loader.dispose(); };
  }, [key, ids]);
  return useMemo(() => {
    const results = loaded?.key === key ? loaded.results : [];
    return {
    resources: new Map(results.filter((result): result is ReadyAsset => result.kind === "ready").map(result => [result.asset.id, result])),
    loading: ids.length > 0 && results.length !== ids.length,
    fallback: results.filter(result => result.kind === "fallback").map(result => result.asset.name),
    };
  }, [ids.length, loaded, key]);
}
