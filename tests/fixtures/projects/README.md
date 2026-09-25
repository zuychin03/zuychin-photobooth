# Synthetic local project fixtures

Four 640 × 480 solid-colour PNGs contain no people or metadata. `synthetic.pbproject` packages those originals with a four-shot Flexible project, the caption `Original bytes intact`, and a fixed capture timestamp of 01/09/2026. They are used for the normal local import/editor smoke flow, never uploaded to cloud services.

The fixture bundle is generated through `createProject`, `appendProjectMedia` and `exportProjectBundle`. Native PNG/JPEG orientation and composition checks generate their own quadrant canvases in the development lab.
