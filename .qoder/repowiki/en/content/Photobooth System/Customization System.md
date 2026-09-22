# Customization System

<cite>
**Referenced Files in This Document**
- [page.tsx](file://app/customize/page.tsx)
- [layout.tsx](file://app/layout.tsx)
- [globals.css](file://app/globals.css)
- [themes.ts](file://lib/themes.ts)
- [layouts.ts](file://lib/layouts.ts)
- [patterns.ts](file://lib/patterns.ts)
- [filters.ts](file://lib/filters.ts)
- [sticker-assets.ts](file://lib/sticker-assets.ts)
- [compose.ts](file://lib/compose.ts)
- [capture.ts](file://lib/capture.ts)
- [camera.ts](file://lib/camera.ts)
- [live-preview.ts](file://lib/live-preview.ts)
- [segmentation.ts](file://lib/segmentation.ts)
- [sound.ts](file://lib/sound.ts)
- [room-code.ts](file://lib/room-code.ts)
- [session.tsx](file://lib/session.tsx)
- [AuthCookieMigration.tsx](file://components/AuthCookieMigration.tsx)
- [CameraPreview.tsx](file://components/CameraPreview.tsx)
- [Countdown.tsx](file://components/Countdown.tsx)
- [FilterBar.tsx](file://components/FilterBar.tsx)
- [InstallPrompt.tsx](file://components/InstallPrompt.tsx)
- [Logo.tsx](file://components/Logo.tsx)
- [PushToggle.tsx](file://components/PushToggle.tsx)
- [PwaRegister.tsx](file://components/PwaRegister.tsx)
- [RoleCapture.tsx](file://components/RoleCapture.tsx)
- [StripMockup.tsx](file://components/StripMockup.tsx)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction
This document explains the Customization System that powers visual personalization and composition within the application. It covers how themes, layouts, patterns, filters, stickers, and audio are composed into a final capture result, and how the UI components orchestrate user interactions for customization. The goal is to provide both a high-level understanding and detailed technical insights for developers and contributors.

## Project Structure
The customization system spans several layers:
- UI pages and layout: entry points and global configuration
- Feature libraries: domain logic for themes, layouts, patterns, filters, stickers, composition, capture, camera, live preview, segmentation, sound, room codes, and session state
- Reusable components: UI building blocks for camera preview, countdown, filter selection, mockups, role capture, and more

```mermaid
graph TB
subgraph "App Layer"
A["app/customize/page.tsx"]
B["app/layout.tsx"]
C["app/globals.css"]
end
subgraph "Libraries"
L1["lib/themes.ts"]
L2["lib/layouts.ts"]
L3["lib/patterns.ts"]
L4["lib/filters.ts"]
L5["lib/sticker-assets.ts"]
L6["lib/compose.ts"]
L7["lib/capture.ts"]
L8["lib/camera.ts"]
L9["lib/live-preview.ts"]
L10["lib/segmentation.ts"]
L11["lib/sound.ts"]
L12["lib/room-code.ts"]
L13["lib/session.tsx"]
end
subgraph "Components"
U1["components/CameraPreview.tsx"]
U2["components/Countdown.tsx"]
U3["components/FilterBar.tsx"]
U4["components/StripMockup.tsx"]
U5["components/RoleCapture.tsx"]
U6["components/Logo.tsx"]
U7["components/AuthCookieMigration.tsx"]
U8["components/InstallPrompt.tsx"]
U9["components/PushToggle.tsx"]
U10["components/PwaRegister.tsx"]
end
A --> L1
A --> L2
A --> L3
A --> L4
A --> L5
A --> L6
A --> L7
A --> L8
A --> L9
A --> L10
A --> L11
A --> L12
A --> L13
A --> U1
A --> U2
A --> U3
A --> U4
A --> U5
A --> U6
B --> C
B --> U7
B --> U8
B --> U9
B --> U10
```

**Diagram sources**
- [page.tsx](file://app/customize/page.tsx)
- [layout.tsx](file://app/layout.tsx)
- [globals.css](file://app/globals.css)
- [themes.ts](file://lib/themes.ts)
- [layouts.ts](file://lib/layouts.ts)
- [patterns.ts](file://lib/patterns.ts)
- [filters.ts](file://lib/filters.ts)
- [sticker-assets.ts](file://lib/sticker-assets.ts)
- [compose.ts](file://lib/compose.ts)
- [capture.ts](file://lib/capture.ts)
- [camera.ts](file://lib/camera.ts)
- [live-preview.ts](file://lib/live-preview.ts)
- [segmentation.ts](file://lib/segmentation.ts)
- [sound.ts](file://lib/sound.ts)
- [room-code.ts](file://lib/room-code.ts)
- [session.tsx](file://lib/session.tsx)
- [CameraPreview.tsx](file://components/CameraPreview.tsx)
- [Countdown.tsx](file://components/Countdown.tsx)
- [FilterBar.tsx](file://components/FilterBar.tsx)
- [StripMockup.tsx](file://components/StripMockup.tsx)
- [RoleCapture.tsx](file://components/RoleCapture.tsx)
- [Logo.tsx](file://components/Logo.tsx)
- [AuthCookieMigration.tsx](file://components/AuthCookieMigration.tsx)
- [InstallPrompt.tsx](file://components/InstallPrompt.tsx)
- [PushToggle.tsx](file://components/PushToggle.tsx)
- [PwaRegister.tsx](file://components/PwaRegister.tsx)

**Section sources**
- [page.tsx](file://app/customize/page.tsx)
- [layout.tsx](file://app/layout.tsx)
- [globals.css](file://app/globals.css)

## Core Components
- Theme and style configuration: centralized theme definitions and CSS variables
- Layout engine: defines grid structures and positioning for multi-photo strips or frames
- Pattern overlays: decorative backgrounds and textures applied over captures
- Filters: image processing pipeline for color adjustments and effects
- Stickers: asset registry and placement utilities for overlay elements
- Composition engine: merges base images, patterns, stickers, and filters into a final output
- Capture pipeline: orchestrates camera access, frame capture, and post-processing
- Live preview: renders real-time previews with selected customizations
- Segmentation: optional background removal or subject isolation for advanced compositions
- Sound: playback cues for countdown and capture feedback
- Room code and session: contextual state for shared sessions and persistence

**Section sources**
- [themes.ts](file://lib/themes.ts)
- [layouts.ts](file://lib/layouts.ts)
- [patterns.ts](file://lib/patterns.ts)
- [filters.ts](file://lib/filters.ts)
- [sticker-assets.ts](file://lib/sticker-assets.ts)
- [compose.ts](file://lib/compose.ts)
- [capture.ts](file://lib/capture.ts)
- [camera.ts](file://lib/camera.ts)
- [live-preview.ts](file://lib/live-preview.ts)
- [segmentation.ts](file://lib/segmentation.ts)
- [sound.ts](file://lib/sound.ts)
- [room-code.ts](file://lib/room-code.ts)
- [session.tsx](file://lib/session.tsx)

## Architecture Overview
The customization system follows a layered architecture:
- Presentation layer (UI components) collects user choices such as theme, layout, filters, stickers, and timing
- Domain layer (libraries) transforms these choices into structured configuration objects
- Processing layer (composition and capture) applies transformations and renders the final media
- State layer (session and room code) persists and shares customization state across devices

```mermaid
sequenceDiagram
participant UI as "Customize Page"
participant Preview as "Live Preview"
participant Config as "Theme/Layout/Filters/Stickers"
participant Compose as "Compose Engine"
participant Capture as "Capture Pipeline"
participant Output as "Final Media"
UI->>Config : "Apply selections"
Config-->>UI : "Updated configuration"
UI->>Preview : "Render preview with config"
Preview-->>UI : "Real-time preview"
UI->>Capture : "Trigger capture"
Capture->>Compose : "Merge assets and effects"
Compose-->>Capture : "Processed frame(s)"
Capture-->>Output : "Save/share result"
```

**Diagram sources**
- [page.tsx](file://app/customize/page.tsx)
- [live-preview.ts](file://lib/live-preview.ts)
- [compose.ts](file://lib/compose.ts)
- [capture.ts](file://lib/capture.ts)

## Detailed Component Analysis

### Customize Page
The customize page coordinates user interactions and delegates to libraries and components:
- Reads and updates customization state (theme, layout, filters, stickers, timing)
- Renders live preview using the preview library
- Triggers capture flow via the capture pipeline
- Integrates session and room context for shared experiences

```mermaid
flowchart TD
Start(["Open Customize Page"]) --> LoadState["Load Session/Room Context"]
LoadState --> ShowUI["Render Customization UI"]
ShowUI --> UserAction{"User Action?"}
UserAction --> |Change Theme| UpdateTheme["Update Theme Config"]
UserAction --> |Change Layout| UpdateLayout["Update Layout Config"]
UserAction --> |Apply Filter| ApplyFilter["Apply Filter Chain"]
UserAction --> |Add Sticker| AddSticker["Place Sticker Asset"]
UpdateTheme --> RefreshPreview["Refresh Live Preview"]
UpdateLayout --> RefreshPreview
ApplyFilter --> RefreshPreview
AddSticker --> RefreshPreview
RefreshPreview --> CaptureChoice{"Capture Requested?"}
CaptureChoice --> |Yes| TriggerCapture["Invoke Capture Pipeline"]
CaptureChoice --> |No| Wait["Wait for Next Action"]
TriggerCapture --> Compose["Compose Final Result"]
Compose --> Save["Persist/Share Output"]
Save --> End(["Done"])
Wait --> UserAction
```

**Diagram sources**
- [page.tsx](file://app/customize/page.tsx)
- [live-preview.ts](file://lib/live-preview.ts)
- [compose.ts](file://lib/compose.ts)
- [capture.ts](file://lib/capture.ts)

**Section sources**
- [page.tsx](file://app/customize/page.tsx)

### Theme and Style Configuration
Centralized theme definitions control colors, typography, and visual accents. Global styles apply consistent design tokens across components.

```mermaid
classDiagram
class Themes {
+applyTheme(themeId)
+getColors()
+getTypography()
}
class GlobalStyles {
+cssVariables
+resetStyles
}
Themes --> GlobalStyles : "updates CSS variables"
```

**Diagram sources**
- [themes.ts](file://lib/themes.ts)
- [globals.css](file://app/globals.css)

**Section sources**
- [themes.ts](file://lib/themes.ts)
- [globals.css](file://app/globals.css)

### Layout Engine
Defines grid structures and positioning rules for photo arrangements, ensuring consistent strip or frame layouts.

```mermaid
classDiagram
class LayoutEngine {
+computeGrid(layoutId, count)
+getPosition(index)
+getDimensions()
}
class LayoutConfig {
+id
+rows
+cols
+gutter
}
LayoutEngine --> LayoutConfig : "reads"
```

**Diagram sources**
- [layouts.ts](file://lib/layouts.ts)

**Section sources**
- [layouts.ts](file://lib/layouts.ts)

### Pattern Overlays
Provides decorative backgrounds and textures that can be composited over captures.

```mermaid
classDiagram
class Patterns {
+listPatterns()
+applyPattern(image, patternId)
}
class PatternAsset {
+id
+url
+blendMode
}
Patterns --> PatternAsset : "loads"
```

**Diagram sources**
- [patterns.ts](file://lib/patterns.ts)

**Section sources**
- [patterns.ts](file://lib/patterns.ts)

### Filters Pipeline
Implements image processing steps for color adjustments and effects.

```mermaid
classDiagram
class Filters {
+listFilters()
+applyFilter(image, filterId)
}
class FilterStep {
+id
+params
+process(canvas)
}
Filters --> FilterStep : "chains"
```

**Diagram sources**
- [filters.ts](file://lib/filters.ts)

**Section sources**
- [filters.ts](file://lib/filters.ts)

### Sticker Assets
Registry and placement utilities for sticker overlays.

```mermaid
classDiagram
class StickerAssets {
+listStickers()
+getAsset(id)
+renderSticker(ctx, asset, x, y, scale)
}
class StickerAsset {
+id
+url
+width
+height
}
StickerAssets --> StickerAsset : "manages"
```

**Diagram sources**
- [sticker-assets.ts](file://lib/sticker-assets.ts)

**Section sources**
- [sticker-assets.ts](file://lib/sticker-assets.ts)

### Composition Engine
Merges base images, patterns, stickers, and filters into a final output.

```mermaid
classDiagram
class ComposeEngine {
+compose(baseImage, layers, filters, stickers)
+renderToCanvas()
+exportBlob()
}
class Layers {
+pattern
+stickers
+effects
}
ComposeEngine --> Layers : "composes"
```

**Diagram sources**
- [compose.ts](file://lib/compose.ts)

**Section sources**
- [compose.ts](file://lib/compose.ts)

### Capture Pipeline
Orchestrates camera access, frame capture, and post-processing.

```mermaid
sequenceDiagram
participant UI as "UI"
participant Camera as "Camera Module"
participant Capture as "Capture Logic"
participant Compose as "Compose Engine"
participant Output as "Result"
UI->>Camera : "Request stream"
Camera-->>UI : "Stream ready"
UI->>Capture : "Capture frame"
Capture->>Compose : "Apply filters and layers"
Compose-->>Capture : "Processed frame"
Capture-->>Output : "Save/share"
```

**Diagram sources**
- [camera.ts](file://lib/camera.ts)
- [capture.ts](file://lib/capture.ts)
- [compose.ts](file://lib/compose.ts)

**Section sources**
- [camera.ts](file://lib/camera.ts)
- [capture.ts](file://lib/capture.ts)

### Live Preview
Renders real-time previews with selected customizations.

```mermaid
classDiagram
class LivePreview {
+updateConfig(config)
+renderFrame()
+dispose()
}
class PreviewCanvas {
+drawLayers()
+applyFilters()
}
LivePreview --> PreviewCanvas : "renders"
```

**Diagram sources**
- [live-preview.ts](file://lib/live-preview.ts)

**Section sources**
- [live-preview.ts](file://lib/live-preview.ts)

### Segmentation
Optional background removal or subject isolation for advanced compositions.

```mermaid
classDiagram
class Segmentation {
+loadModel()
+segment(image)
+applyMask(image, mask)
}
Segmentation --> Segmentation : "uses wasm models"
```

**Diagram sources**
- [segmentation.ts](file://lib/segmentation.ts)

**Section sources**
- [segmentation.ts](file://lib/segmentation.ts)

### Sound
Playback cues for countdown and capture feedback.

```mermaid
classDiagram
class SoundManager {
+play(countdown)
+play(capture)
+stop()
}
```

**Diagram sources**
- [sound.ts](file://lib/sound.ts)

**Section sources**
- [sound.ts](file://lib/sound.ts)

### Room Code and Session
Contextual state for shared sessions and persistence.

```mermaid
classDiagram
class RoomCode {
+generate()
+parse(code)
}
class Session {
+getState()
+setState(updates)
+persist()
}
RoomCode --> Session : "links session to room"
```

**Diagram sources**
- [room-code.ts](file://lib/room-code.ts)
- [session.tsx](file://lib/session.tsx)

**Section sources**
- [room-code.ts](file://lib/room-code.ts)
- [session.tsx](file://lib/session.tsx)

### UI Components
Reusable components that implement the customization experience:
- CameraPreview: displays live camera feed and overlays
- Countdown: shows countdown timers before capture
- FilterBar: allows users to select and preview filters
- StripMockup: visualizes final strip layout
- RoleCapture: manages roles for multi-person captures
- Logo: brand overlay component
- AuthCookieMigration: handles authentication cookie migration
- InstallPrompt: prompts PWA installation
- PushToggle: toggles push notifications
- PwaRegister: registers service worker for offline support

```mermaid
classDiagram
class CameraPreview {
+start()
+stop()
+overlay(assets)
}
class Countdown {
+start(seconds)
+onComplete(callback)
}
class FilterBar {
+setFilters(list)
+onSelect(filterId)
}
class StripMockup {
+setLayout(layoutId)
+render()
}
class RoleCapture {
+addRole(role)
+removeRole(role)
+captureAll()
}
class Logo {
+render(position)
}
class AuthCookieMigration {
+migrate()
}
class InstallPrompt {
+show()
+dismiss()
}
class PushToggle {
+toggle(enabled)
}
class PwaRegister {
+register()
}
```

**Diagram sources**
- [CameraPreview.tsx](file://components/CameraPreview.tsx)
- [Countdown.tsx](file://components/Countdown.tsx)
- [FilterBar.tsx](file://components/FilterBar.tsx)
- [StripMockup.tsx](file://components/StripMockup.tsx)
- [RoleCapture.tsx](file://components/RoleCapture.tsx)
- [Logo.tsx](file://components/Logo.tsx)
- [AuthCookieMigration.tsx](file://components/AuthCookieMigration.tsx)
- [InstallPrompt.tsx](file://components/InstallPrompt.tsx)
- [PushToggle.tsx](file://components/PushToggle.tsx)
- [PwaRegister.tsx](file://components/PwaRegister.tsx)

**Section sources**
- [CameraPreview.tsx](file://components/CameraPreview.tsx)
- [Countdown.tsx](file://components/Countdown.tsx)
- [FilterBar.tsx](file://components/FilterBar.tsx)
- [StripMockup.tsx](file://components/StripMockup.tsx)
- [RoleCapture.tsx](file://components/RoleCapture.tsx)
- [Logo.tsx](file://components/Logo.tsx)
- [AuthCookieMigration.tsx](file://components/AuthCookieMigration.tsx)
- [InstallPrompt.tsx](file://components/InstallPrompt.tsx)
- [PushToggle.tsx](file://components/PushToggle.tsx)
- [PwaRegister.tsx](file://components/PwaRegister.tsx)

## Dependency Analysis
The customization system exhibits clear separation between UI, domain logic, and processing layers. Libraries encapsulate specific capabilities and are consumed by the customize page and components.

```mermaid
graph LR
CustomizePage["customize/page.tsx"] --> Themes["themes.ts"]
CustomizePage --> Layouts["layouts.ts"]
CustomizePage --> Patterns["patterns.ts"]
CustomizePage --> Filters["filters.ts"]
CustomizePage --> Stickers["sticker-assets.ts"]
CustomizePage --> Compose["compose.ts"]
CustomizePage --> Capture["capture.ts"]
CustomizePage --> Camera["camera.ts"]
CustomizePage --> LivePreview["live-preview.ts"]
CustomizePage --> Segmentation["segmentation.ts"]
CustomizePage --> Sound["sound.ts"]
CustomizePage --> RoomCode["room-code.ts"]
CustomizePage --> Session["session.tsx"]
CustomizePage --> CameraPreview["CameraPreview.tsx"]
CustomizePage --> Countdown["Countdown.tsx"]
CustomizePage --> FilterBar["FilterBar.tsx"]
CustomizePage --> StripMockup["StripMockup.tsx"]
CustomizePage --> RoleCapture["RoleCapture.tsx"]
CustomizePage --> Logo["Logo.tsx"]
Layout["layout.tsx"] --> GlobalCSS["globals.css"]
Layout --> AuthCookieMigration["AuthCookieMigration.tsx"]
Layout --> InstallPrompt["InstallPrompt.tsx"]
Layout --> PushToggle["PushToggle.tsx"]
Layout --> PwaRegister["PwaRegister.tsx"]
```

**Diagram sources**
- [page.tsx](file://app/customize/page.tsx)
- [layout.tsx](file://app/layout.tsx)
- [globals.css](file://app/globals.css)
- [themes.ts](file://lib/themes.ts)
- [layouts.ts](file://lib/layouts.ts)
- [patterns.ts](file://lib/patterns.ts)
- [filters.ts](file://lib/filters.ts)
- [sticker-assets.ts](file://lib/sticker-assets.ts)
- [compose.ts](file://lib/compose.ts)
- [capture.ts](file://lib/capture.ts)
- [camera.ts](file://lib/camera.ts)
- [live-preview.ts](file://lib/live-preview.ts)
- [segmentation.ts](file://lib/segmentation.ts)
- [sound.ts](file://lib/sound.ts)
- [room-code.ts](file://lib/room-code.ts)
- [session.tsx](file://lib/session.tsx)
- [CameraPreview.tsx](file://components/CameraPreview.tsx)
- [Countdown.tsx](file://components/Countdown.tsx)
- [FilterBar.tsx](file://components/FilterBar.tsx)
- [StripMockup.tsx](file://components/StripMockup.tsx)
- [RoleCapture.tsx](file://components/RoleCapture.tsx)
- [Logo.tsx](file://components/Logo.tsx)
- [AuthCookieMigration.tsx](file://components/AuthCookieMigration.tsx)
- [InstallPrompt.tsx](file://components/InstallPrompt.tsx)
- [PushToggle.tsx](file://components/PushToggle.tsx)
- [PwaRegister.tsx](file://components/PwaRegister.tsx)

**Section sources**
- [page.tsx](file://app/customize/page.tsx)
- [layout.tsx](file://app/layout.tsx)

## Performance Considerations
- Prefer lazy loading of heavy assets (models, stickers) to reduce initial bundle size
- Use offscreen canvases for compositing to avoid main-thread blocking
- Throttle live preview updates during rapid user input
- Cache computed layouts and filter chains where possible
- Optimize segmentation model loading and reuse instances across captures

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common issues and resolutions:
- Camera access denied: verify permissions and HTTPS requirements
- Preview not updating: ensure live preview is disposed and reinitialized after config changes
- Capture fails: check stream availability and canvas dimensions
- Stickers not rendering: validate asset URLs and cross-origin settings
- Filters look incorrect: confirm filter order and parameter ranges
- Segmentation errors: ensure wasm models are loaded and compatible with browser

[No sources needed since this section provides general guidance]

## Conclusion
The Customization System integrates UI, domain logic, and processing layers to deliver a flexible and performant personalization experience. By separating concerns and leveraging modular libraries, it supports extensibility for new themes, layouts, filters, stickers, and effects while maintaining a smooth user experience through live preview and efficient capture pipelines.

[No sources needed since this section summarizes without analyzing specific files]