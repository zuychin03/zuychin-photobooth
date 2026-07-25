# Project Overview

<cite>
**Referenced Files in This Document**
- [README.md](file://README.md)
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)
- [app/page.tsx](file://app/page.tsx)
- [app/layout.tsx](file://app/layout.tsx)
- [app/booth/page.tsx](file://app/booth/page.tsx)
- [app/relay/new/page.tsx](file://app/relay/new/page.tsx)
- [app/relay/[id]/page.tsx](file://app/relay/[id]/page.tsx)
- [app/room/[code]/page.tsx](file://app/room/[code]/page.tsx)
- [components/CameraPreview.tsx](file://components/CameraPreview.tsx)
- [components/Countdown.tsx](file://components/Countdown.tsx)
- [components/FilterBar.tsx](file://components/FilterBar.tsx)
- [hooks/useCamera.ts](file://hooks/useCamera.ts)
- [lib/capture.ts](file://lib/capture.ts)
- [lib/cloudinary.ts](file://lib/cloudinary.ts)
- [lib/live-preview.ts](file://lib/live-preview.ts)
- [lib/relay.ts](file://lib/relay.ts)
- [lib/session.tsx](file://lib/session.tsx)
- [lib/scenes.ts](file://lib/scenes.ts)
- [lib/filters.ts](file://lib/filters.ts)
- [lib/layouts.ts](file://lib/layouts.ts)
- [lib/segmentation.ts](file://lib/segmentation.ts)
- [public/sw.js](file://public/sw.js)
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
Zuychin Photobooth is a modern, web-based photobooth application designed to deliver an engaging, real-time photo capture experience with advanced editing and cloud integration. It enables users to create fun photo strips, apply filters and stickers, collaborate in real time, and share results instantly. The app supports both single-user sessions and multi-user collaboration through room sessions and relay flows, making it suitable for events, parties, or everyday use.

Key features:
- Real-time collaboration via WebRTC-powered relay and room sessions
- Advanced photo editing with filters, layouts, and segmentation effects
- Cloud integration for storage and sharing using Cloudinary
- Progressive Web App (PWA) support for offline-friendly experiences
- Streamlined capture workflow from landing page to final photo sharing

The technology stack includes Next.js for the full-stack framework, Supabase for authentication and data services, Cloudinary for media handling, WebRTC for real-time communication, and MediaPipe for on-device segmentation and effects.

## Project Structure
The project follows a Next.js App Router structure with feature-oriented directories:
- app/: Routes and pages for booth, relay, room sessions, timeline, and more
- components/: Reusable UI components such as camera preview, countdown, filter bar
- hooks/: Custom React hooks like useCamera for camera access
- lib/: Core logic modules including capture, cloud upload, live preview, relay, session management, filters, layouts, and segmentation
- public/: Static assets including PWA service worker and MediaPipe WASM files

```mermaid
graph TB
A["app/page.tsx"] --> B["app/layout.tsx"]
B --> C["components/*"]
B --> D["hooks/*"]
B --> E["lib/*"]
E --> F["lib/capture.ts"]
E --> G["lib/cloudinary.ts"]
E --> H["lib/live-preview.ts"]
E --> I["lib/relay.ts"]
E --> J["lib/session.tsx"]
E --> K["lib/filters.ts"]
E --> L["lib/layouts.ts"]
E --> M["lib/segmentation.ts"]
C --> N["components/CameraPreview.tsx"]
C --> O["components/Countdown.tsx"]
C --> P["components/FilterBar.tsx"]
D --> Q["hooks/useCamera.ts"]
```

**Diagram sources**
- [app/page.tsx](file://app/page.tsx)
- [app/layout.tsx](file://app/layout.tsx)
- [components/CameraPreview.tsx](file://components/CameraPreview.tsx)
- [components/Countdown.tsx](file://components/Countdown.tsx)
- [components/FilterBar.tsx](file://components/FilterBar.tsx)
- [hooks/useCamera.ts](file://hooks/useCamera.ts)
- [lib/capture.ts](file://lib/capture.ts)
- [lib/cloudinary.ts](file://lib/cloudinary.ts)
- [lib/live-preview.ts](file://lib/live-preview.ts)
- [lib/relay.ts](file://lib/relay.ts)
- [lib/session.tsx](file://lib/session.tsx)
- [lib/filters.ts](file://lib/filters.ts)
- [lib/layouts.ts](file://lib/layouts.ts)
- [lib/segmentation.ts](file://lib/segmentation.ts)

**Section sources**
- [README.md](file://README.md)
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)

## Core Components
The application is built around several core components that handle user interactions, media processing, and state management:

- CameraPreview: Renders live camera feed and handles video stream management
- Countdown: Provides visual countdown timers for photo capture
- FilterBar: Allows users to select and apply various photo filters
- useCamera hook: Manages camera permissions and stream lifecycle
- Capture workflow: Orchestrates the sequence from preview to final image capture
- Relay system: Enables real-time collaboration between multiple users
- Room sessions: Facilitates group photo sessions with shared state

These components work together to create a seamless photobooth experience, with clear separation between UI components, business logic, and service layers.

**Section sources**
- [components/CameraPreview.tsx](file://components/CameraPreview.tsx)
- [components/Countdown.tsx](file://components/Countdown.tsx)
- [components/FilterBar.tsx](file://components/FilterBar.tsx)
- [hooks/useCamera.ts](file://hooks/useCamera.ts)
- [lib/capture.ts](file://lib/capture.ts)

## Architecture Overview
The Zuychin Photobooth follows a layered architecture pattern with clear separation of concerns:

```mermaid
graph TB
subgraph "Presentation Layer"
UI[React Components]
Pages[Next.js Pages]
Hooks[Custom Hooks]
end
subgraph "Business Logic Layer"
Capture[Capture Workflow]
Filters[Filter Processing]
Segmentation[MediaPipe Segmentation]
Layouts[Photo Layouts]
end
subgraph "Service Layer"
Session[Session Management]
Relay[Real-time Relay]
Cloudinary[Cloud Storage]
LivePreview[Live Preview Service]
end
subgraph "External Services"
Supabase[Supabase Auth & DB]
CloudAPI[Cloudinary API]
WebRTC[WebRTC Communication]
end
UI --> Capture
UI --> Filters
UI --> Session
Capture --> Segmentation
Capture --> Cloudinary
Session --> Relay
Relay --> WebRTC
Cloudinary --> CloudAPI
Session --> Supabase
```

**Diagram sources**
- [lib/capture.ts](file://lib/capture.ts)
- [lib/filters.ts](file://lib/filters.ts)
- [lib/segmentation.ts](file://lib/segmentation.ts)
- [lib/layouts.ts](file://lib/layouts.ts)
- [lib/session.tsx](file://lib/session.tsx)
- [lib/relay.ts](file://lib/relay.ts)
- [lib/cloudinary.ts](file://lib/cloudinary.ts)
- [lib/live-preview.ts](file://lib/live-preview.ts)

The architecture emphasizes modularity and testability, with each layer having specific responsibilities and well-defined interfaces for communication between components.

## Detailed Component Analysis

### Booth Component Analysis
The booth component serves as the main photobooth interface, providing the primary user interaction point for photo capture and editing.

```mermaid
classDiagram
class BoothComponent {
+cameraStream : MediaStream
+capturedImage : HTMLCanvasElement
+currentFilter : string
+applyFilter(filterName) void
+capturePhoto() Promise~Blob~
+resetSession() void
}
class CameraPreview {
+videoElement : HTMLVideoElement
+startStream() Promise~MediaStream~
+stopStream() void
+getFrame() HTMLCanvasElement
}
class CaptureWorkflow {
+initiateCapture() void
+processImage(imageData) Promise~Blob~
+uploadToCloud(blob) Promise~string~
+sharePhoto(url) void
}
BoothComponent --> CameraPreview : "uses"
BoothComponent --> CaptureWorkflow : "orchestrates"
CameraPreview --> CaptureWorkflow : "provides frames"
```

**Diagram sources**
- [app/booth/page.tsx](file://app/booth/page.tsx)
- [components/CameraPreview.tsx](file://components/CameraPreview.tsx)
- [lib/capture.ts](file://lib/capture.ts)

### Relay System Analysis
The relay system enables real-time collaboration between multiple users, allowing them to share camera feeds and coordinate photo sessions.

```mermaid
sequenceDiagram
participant User1 as "User 1"
participant Booth as "Booth Component"
participant Relay as "Relay Service"
participant Peer as "Peer Connection"
participant Cloud as "Cloudinary"
User1->>Booth : Start Photo Session
Booth->>Relay : Initialize Relay
Relay->>Peer : Create WebRTC Connection
Peer-->>Relay : Connection Established
Relay-->>Booth : Ready for Collaboration
Booth->>Peer : Share Camera Stream
Peer-->>Booth : Receive Remote Streams
Booth->>Booth : Apply Filters & Effects
Booth->>Cloud : Upload Final Image
Cloud-->>Booth : Return Share URL
Booth-->>User1 : Display Shared Result
```

**Diagram sources**
- [lib/relay.ts](file://lib/relay.ts)
- [app/relay/new/page.tsx](file://app/relay/new/page.tsx)
- [app/relay/[id]/page.tsx](file://app/relay/[id]/page.tsx)

### Room Sessions Analysis
Room sessions facilitate group photo activities where multiple participants can join a shared session code.

```mermaid
flowchart TD
Start([Start Room Session]) --> CreateCode["Generate Room Code"]
CreateCode --> ShareCode["Share Code with Participants"]
ShareCode --> JoinRoom{"Participant Joins?"}
JoinRoom --> |Yes| SyncState["Sync Session State"]
JoinRoom --> |No| Wait["Wait for Participants"]
SyncState --> Collaborate["Collaborative Photo Session"]
Collaborate --> CaptureGroup["Group Photo Capture"]
CaptureGroup --> ProcessImages["Process & Edit Images"]
ProcessImages --> ShareResults["Share Results"]
ShareResults --> End([End Session])
Wait --> JoinRoom
```

**Diagram sources**
- [app/room/[code]/page.tsx](file://app/room/[code]/page.tsx)
- [lib/session.tsx](file://lib/session.tsx)

**Section sources**
- [app/booth/page.tsx](file://app/booth/page.tsx)
- [lib/relay.ts](file://lib/relay.ts)
- [lib/session.tsx](file://lib/session.tsx)

## Dependency Analysis
The application has a well-structured dependency hierarchy with clear separation between presentation, business logic, and external services.

```mermaid
graph TB
subgraph "UI Layer Dependencies"
CameraPreview --> useCamera
CameraPreview --> live-preview
FilterBar --> filters
Countdown --> sound
end
subgraph "Business Logic Dependencies"
capture --> segmentation
capture --> filters
capture --> layouts
relay --> session
session --> auth
end
subgraph "External Service Dependencies"
cloudinary --> http-api
relay --> webrtc
session --> supabase
end
useCamera --> camera-api
live-preview --> camera-api
segmentation --> mediapipe
```

**Diagram sources**
- [components/CameraPreview.tsx](file://components/CameraPreview.tsx)
- [hooks/useCamera.ts](file://hooks/useCamera.ts)
- [lib/live-preview.ts](file://lib/live-preview.ts)
- [lib/filters.ts](file://lib/filters.ts)
- [lib/capture.ts](file://lib/capture.ts)
- [lib/segmentation.ts](file://lib/segmentation.ts)
- [lib/relay.ts](file://lib/relay.ts)
- [lib/session.tsx](file://lib/session.tsx)
- [lib/cloudinary.ts](file://lib/cloudinary.ts)

The dependency structure ensures loose coupling between components while maintaining clear communication patterns through well-defined interfaces and service contracts.

**Section sources**
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)

## Performance Considerations
The application implements several performance optimization strategies:

- **Lazy Loading**: Components and libraries are loaded on-demand to reduce initial bundle size
- **Streaming Media**: Camera streams are managed efficiently with proper resource cleanup
- **Client-side Processing**: Image filtering and effects are processed locally when possible
- **Caching Strategies**: Frequently used assets and configurations are cached appropriately
- **Progressive Enhancement**: Core functionality works without JavaScript for basic features
- **Memory Management**: Proper cleanup of camera streams and canvas operations prevents memory leaks

The PWA implementation provides offline capabilities and improved loading performance through service worker caching strategies.

## Troubleshooting Guide
Common issues and their solutions:

**Camera Access Problems:**
- Ensure HTTPS is enabled for camera access
- Check browser permissions for camera and microphone
- Verify device compatibility with WebRTC APIs

**Real-time Collaboration Issues:**
- Validate WebRTC connection establishment
- Check firewall settings for peer-to-peer communication
- Monitor network connectivity and bandwidth limitations

**Image Processing Errors:**
- Verify MediaPipe model loading and initialization
- Check canvas dimensions and image format compatibility
- Monitor memory usage during heavy image operations

**Cloud Upload Failures:**
- Validate Cloudinary credentials and configuration
- Check network connectivity and API rate limits
- Implement retry mechanisms for failed uploads

**Section sources**
- [public/sw.js](file://public/sw.js)
- [lib/capture.ts](file://lib/capture.ts)
- [lib/cloudinary.ts](file://lib/cloudinary.ts)

## Conclusion
Zuychin Photobooth represents a comprehensive solution for modern web-based photobooth applications. Its architecture balances ease of use for beginners with powerful features for experienced developers. The modular design allows for easy customization and extension, while the robust feature set supports both casual and professional use cases.

The application successfully combines cutting-edge web technologies with intuitive user interfaces to deliver a seamless photobooth experience. Future enhancements could include additional filter types, advanced editing tools, and expanded social sharing capabilities.