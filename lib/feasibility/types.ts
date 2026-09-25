export interface ProbeResult {
  id: string;
  status: "pass" | "fail" | "unsupported";
  detail: string;
  metrics?: Record<string, string | number | boolean>;
}
