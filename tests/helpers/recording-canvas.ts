import type { TestContext } from "node:test";

type Rect = [number, number, number, number];

export interface ImageDraw {
  source: unknown;
  coordinates: number[];
  filter: string | undefined;
  clip: Rect | null;
}

interface CanvasState {
  filter: string | undefined;
  fillStyle: unknown;
  clip: Rect | null;
}

interface CanvasOptions {
  supportsFilter?: boolean;
  blobResult?: Blob | null;
  drawError?: Error;
  missingContext?: boolean;
}

// Records geometry and state; it does not rasterise or validate visual output.
export class RecordingContext {
  filter: string | undefined;
  fillStyle: unknown = "#000000";
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  shadowColor = "transparent";
  shadowBlur = 0;
  readonly draws: ImageDraw[] = [];
  readonly fills: { coordinates: number[]; filter: string | undefined }[] = [];
  readonly texts: { text: string; filter: string | undefined }[] = [];
  readonly transforms: { kind: string; values: number[] }[] = [];
  private readonly stack: CanvasState[] = [];
  private pathRect: Rect | null = null;
  private clipRect: Rect | null = null;

  constructor(private options: CanvasOptions) {
    this.filter = options.supportsFilter === false ? undefined : "none";
  }

  save(): void {
    this.stack.push({ filter: this.filter, fillStyle: this.fillStyle, clip: this.clipRect });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) throw new Error("Unbalanced canvas restore");
    this.filter = state.filter;
    this.fillStyle = state.fillStyle;
    this.clipRect = state.clip;
  }

  get savedStateCount(): number {
    return this.stack.length;
  }

  translate(...values: number[]): void {
    this.transforms.push({ kind: "translate", values });
  }

  scale(...values: number[]): void {
    this.transforms.push({ kind: "scale", values });
  }

  rotate(...values: number[]): void {
    this.transforms.push({ kind: "rotate", values });
  }

  beginPath(): void {
    this.pathRect = null;
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.pathRect = [x, y, width, height];
  }

  clip(): void {
    this.clipRect = this.pathRect;
  }

  drawImage(source: unknown, ...coordinates: number[]): void {
    if (this.options.drawError) throw this.options.drawError;
    this.draws.push({ source, coordinates, filter: this.filter, clip: this.clipRect });
  }

  fillRect(...coordinates: number[]): void {
    this.fills.push({ coordinates, filter: this.filter });
  }

  fillText(text: string): void {
    this.texts.push({ text, filter: this.filter });
  }

  createLinearGradient(): { addColorStop: (offset: number, colour: string) => void } {
    const stops: [number, string][] = [];
    return { addColorStop: (offset, colour) => { stops.push([offset, colour]); } };
  }

  createRadialGradient(): { addColorStop: (offset: number, colour: string) => void } {
    return this.createLinearGradient();
  }
}

export class RecordingCanvas {
  width = 300;
  height = 150;
  readonly context: RecordingContext;
  readonly encodes: { type: string; quality: number | undefined }[] = [];

  constructor(private options: CanvasOptions = {}) {
    this.context = new RecordingContext(options);
  }

  get element(): HTMLCanvasElement {
    return this as unknown as HTMLCanvasElement;
  }

  getContext(kind: string): RecordingContext | null {
    if (kind !== "2d") throw new Error(`Unsupported test context: ${kind}`);
    return this.options.missingContext ? null : this.context;
  }

  toBlob(callback: BlobCallback, type = "image/png", quality?: number): void {
    this.encodes.push({ type, quality });
    const result = this.options.blobResult;
    callback(result === undefined ? new Blob(["encoded fixture"], { type }) : result);
  }
}

export function stubGlobal(t: TestContext, name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
}

export function installCanvasEnvironment(t: TestContext, options: CanvasOptions = {}) {
  const canvases: RecordingCanvas[] = [];
  stubGlobal(t, "document", {
    documentElement: {},
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`Unexpected element: ${tag}`);
      const canvas = new RecordingCanvas(options);
      canvases.push(canvas);
      return canvas.element;
    },
  });
  stubGlobal(t, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  return { canvases };
}

export function immutableSource(width: number, height: number): HTMLCanvasElement {
  return Object.freeze({
    width,
    height,
    getContext() {
      throw new Error("Composition must not draw into an original");
    },
  }) as unknown as HTMLCanvasElement;
}
