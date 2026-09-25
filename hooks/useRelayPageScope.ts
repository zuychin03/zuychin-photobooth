"use client";
import { useLayoutEffect, useState } from "react";
import { createRelayPageScope } from "@/lib/relay-page-scope";

export function useRelayPageScope() {
  const [scope] = useState(createRelayPageScope);
  useLayoutEffect(() => scope.activate(), [scope]);
  return scope;
}
