# Third-party notices

The app's on-device bean-photo cut-out bundles or ships the components below.
Each is distributed under a permissive licence, so a link plus the copyright
line is enough; no full licence text is reproduced.

## onnxruntime-web 1.30.0

Runtime for the two ONNX models below, bundled into the app.

- Copyright (c) Microsoft Corporation.
- Licensed under the MIT License.
- Source: https://github.com/microsoft/onnxruntime
- Licence: https://github.com/microsoft/onnxruntime/blob/main/LICENSE

## IS-Net general-use (int8)

Foreground/alpha model used for the first cut-out pass.

- The "general use" IS-Net checkpoint is derived from the DIS (Dichotomous
  Image Segmentation) model by Xuebin Qin et al., distributed through rembg,
  and shipped here as an int8 quantisation.
- Licensed under the Apache License 2.0.
- Sources: https://github.com/xuebinqin/DIS and
  https://github.com/danielgatis/rembg
- Licence: https://github.com/xuebinqin/DIS/blob/main/LICENSE

## SlimSAM-77 uniform (q8)

Vision encoder and prompt/decoder pair used for the interactive mask pass.

- SlimSAM by Zigeng Chen et al., built on Segment Anything (Meta); the ONNX
  export is by Xenova.
- Licensed under the Apache License 2.0.
- Sources: https://github.com/facebookresearch/segment-anything and
  https://huggingface.co/Xenova/slimsam-77-uniform
- Licence: https://github.com/facebookresearch/segment-anything/blob/main/LICENSE

## Segment Anything

The promptable-segmentation architecture SlimSAM derives from.

- Copyright (c) Meta Platforms, Inc. and affiliates.
- Licensed under the Apache License 2.0.
- Source: https://github.com/facebookresearch/segment-anything
- Licence: https://github.com/facebookresearch/segment-anything/blob/main/LICENSE

The model files themselves are not stored in this repository. They are
published, with their SHA-256 checksums and provenance, in the
[glp-models release repository](https://github.com/mxkissnr/glp-models).
