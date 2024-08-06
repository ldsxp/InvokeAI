import type { Store } from '@reduxjs/toolkit';
import { logger } from 'app/logging/logger';
import type { RootState } from 'app/store/store';
import type { JSONObject } from 'common/types';
import { PubSub } from 'common/util/PubSub/PubSub';
import type { CanvasBrushLineRenderer } from 'features/controlLayers/konva/CanvasBrushLine';
import type { CanvasEraserLineRenderer } from 'features/controlLayers/konva/CanvasEraserLine';
import type { CanvasImageRenderer } from 'features/controlLayers/konva/CanvasImage';
import { CanvasInitialImage } from 'features/controlLayers/konva/CanvasInitialImage';
import { CanvasObjectRenderer } from 'features/controlLayers/konva/CanvasObjectRenderer';
import { CanvasProgressPreview } from 'features/controlLayers/konva/CanvasProgressPreview';
import type { CanvasRectRenderer } from 'features/controlLayers/konva/CanvasRect';
import type { CanvasTransformer } from 'features/controlLayers/konva/CanvasTransformer';
import {
  getCompositeLayerImage,
  getControlAdapterImage,
  getGenerationMode,
  getInitialImage,
  getInpaintMaskImage,
  getPrefixedId,
  getRegionMaskImage,
  nanoid,
} from 'features/controlLayers/konva/util';
import type { Extents, ExtentsResult, GetBboxTask, WorkerLogMessage } from 'features/controlLayers/konva/worker';
import { $lastProgressEvent, $shouldShowStagedImage } from 'features/controlLayers/store/canvasV2Slice';
import {
  type CanvasControlAdapterState,
  type CanvasEntityIdentifier,
  type CanvasEntityState,
  type CanvasInpaintMaskState,
  type CanvasLayerState,
  type CanvasRegionalGuidanceState,
  type CanvasV2State,
  type Coordinate,
  type GenerationMode,
  type GetLoggingContext,
  RGBA_WHITE,
  type RgbaColor,
} from 'features/controlLayers/store/types';
import type Konva from 'konva';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';
import { getImageDTO as defaultGetImageDTO, uploadImage as defaultUploadImage } from 'services/api/endpoints/images';
import type { ImageCategory, ImageDTO } from 'services/api/types';
import { assert } from 'tsafe';

import { CanvasBackground } from './CanvasBackground';
import { CanvasBbox } from './CanvasBbox';
import { CanvasControlAdapter } from './CanvasControlAdapter';
import { CanvasInpaintMask } from './CanvasInpaintMask';
import { CanvasLayer } from './CanvasLayer';
import { CanvasPreview } from './CanvasPreview';
import { CanvasRegion } from './CanvasRegion';
import { CanvasStagingArea } from './CanvasStagingArea';
import { CanvasStateApi } from './CanvasStateApi';
import { CanvasTool } from './CanvasTool';
import { setStageEventHandlers } from './events';

// type Extents = {
//   minX: number;
//   minY: number;
//   maxX: number;
//   maxY: number;
// };
// type GetBboxTask = {
//   id: string;
//   type: 'get_bbox';
//   data: { imageData: ImageData };
// };

// type GetBboxResult = {
//   id: string;
//   type: 'get_bbox';
//   data: { extents: Extents | null };
// };

type Util = {
  getImageDTO: (imageName: string) => Promise<ImageDTO | null>;
  uploadImage: (
    blob: Blob,
    fileName: string,
    image_category: ImageCategory,
    is_intermediate: boolean
  ) => Promise<ImageDTO>;
};

type EntityStateAndAdapter =
  | {
      state: CanvasLayerState;
      adapter: CanvasLayer;
    }
  | {
      state: CanvasInpaintMaskState;
      adapter: CanvasInpaintMask;
    }
  | {
      state: CanvasControlAdapterState;
      adapter: CanvasControlAdapter;
    }
  | {
      state: CanvasRegionalGuidanceState;
      adapter: CanvasRegion;
    };

export const $canvasManager = atom<CanvasManager | null>(null);

export class CanvasManager {
  static BBOX_PADDING_PX = 5;
  static BBOX_DEBOUNCE_MS = 300;

  stage: Konva.Stage;
  container: HTMLDivElement;
  controlAdapters: Map<string, CanvasControlAdapter>;
  layers: Map<string, CanvasLayer>;
  regions: Map<string, CanvasRegion>;
  inpaintMask: CanvasInpaintMask;
  initialImage: CanvasInitialImage;
  util: Util;
  stateApi: CanvasStateApi;
  preview: CanvasPreview;
  background: CanvasBackground;

  log: Logger;
  workerLog: Logger;

  transformingEntity: PubSub<CanvasEntityIdentifier | null>;

  _store: Store<RootState>;
  _prevState: CanvasV2State;
  _isFirstRender: boolean = true;
  _isDebugging: boolean = false;

  _worker: Worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'worker' });
  _tasks: Map<string, { task: GetBboxTask; onComplete: (extents: Extents | null) => void }> = new Map();

  toolState: PubSub<CanvasV2State['tool']>;
  currentFill: PubSub<RgbaColor>;
  selectedEntity: PubSub<EntityStateAndAdapter | null>;
  selectedEntityIdentifier: PubSub<CanvasEntityIdentifier | null>;

  constructor(
    stage: Konva.Stage,
    container: HTMLDivElement,
    store: Store<RootState>,
    getImageDTO: Util['getImageDTO'] = defaultGetImageDTO,
    uploadImage: Util['uploadImage'] = defaultUploadImage
  ) {
    this.stage = stage;
    this.container = container;
    this._store = store;
    this.stateApi = new CanvasStateApi(this._store, this);
    this._prevState = this.stateApi.getState();

    this.log = logger('canvas').child((message) => {
      return {
        ...message,
        context: {
          ...message.context,
          ...this.getLoggingContext(),
        },
      };
    });
    this.workerLog = logger('worker');

    this.util = {
      getImageDTO,
      uploadImage,
    };

    this.preview = new CanvasPreview(
      new CanvasBbox(this),
      new CanvasTool(this),
      new CanvasStagingArea(this),
      new CanvasProgressPreview(this)
    );
    this.stage.add(this.preview.layer);

    this.background = new CanvasBackground(this);
    this.stage.add(this.background.konva.layer);

    this.layers = new Map();
    this.regions = new Map();
    this.controlAdapters = new Map();

    this.initialImage = new CanvasInitialImage(this.stateApi.getInitialImageState(), this);
    this.stage.add(this.initialImage.konva.layer);

    this._worker.onmessage = (event: MessageEvent<ExtentsResult | WorkerLogMessage>) => {
      const { type, data } = event.data;
      if (type === 'log') {
        if (data.ctx) {
          this.workerLog[data.level](data.ctx, data.message);
        } else {
          this.workerLog[data.level](data.message);
        }
      } else if (type === 'extents') {
        const task = this._tasks.get(data.id);
        if (!task) {
          return;
        }
        task.onComplete(data.extents);
        this._tasks.delete(data.id);
      }
    };
    this._worker.onerror = (event) => {
      this.log.error({ message: event.message }, 'Worker error');
    };
    this._worker.onmessageerror = () => {
      this.log.error('Worker message error');
    };

    this.transformingEntity = new PubSub<CanvasEntityIdentifier | null>(null);
    this.toolState = new PubSub(this.stateApi.getToolState());
    this.currentFill = new PubSub(this.getCurrentFill());
    this.selectedEntityIdentifier = new PubSub(
      this.stateApi.getState().selectedEntityIdentifier,
      (a, b) => a?.id === b?.id
    );
    this.selectedEntity = new PubSub(
      this.getSelectedEntity(),
      (a, b) => a?.state === b?.state && a?.adapter === b?.adapter
    );

    this.inpaintMask = new CanvasInpaintMask(this.stateApi.getInpaintMaskState(), this);
    this.stage.add(this.inpaintMask.konva.layer);
  }

  enableDebugging() {
    this._isDebugging = true;
    this.logDebugInfo();
  }

  disableDebugging() {
    this._isDebugging = false;
  }

  requestBbox(data: Omit<GetBboxTask['data'], 'id'>, onComplete: (extents: Extents | null) => void) {
    const id = nanoid();
    const task: GetBboxTask = {
      type: 'get_bbox',
      data: { ...data, id },
    };
    this._tasks.set(id, { task, onComplete });
    this._worker.postMessage(task, [data.buffer]);
  }

  async renderInitialImage() {
    await this.initialImage.render(this.stateApi.getInitialImageState());
  }

  async renderRegions() {
    const { entities } = this.stateApi.getRegionsState();

    // Destroy the konva nodes for nonexistent entities
    for (const canvasRegion of this.regions.values()) {
      if (!entities.find((rg) => rg.id === canvasRegion.id)) {
        canvasRegion.destroy();
        this.regions.delete(canvasRegion.id);
      }
    }

    for (const entity of entities) {
      let adapter = this.regions.get(entity.id);
      if (!adapter) {
        adapter = new CanvasRegion(entity, this);
        this.regions.set(adapter.id, adapter);
        this.stage.add(adapter.konva.layer);
      }
      await adapter.render(entity);
    }
  }

  async renderProgressPreview() {
    await this.preview.progressPreview.render(this.stateApi.$lastProgressEvent.get());
  }

  async renderControlAdapters() {
    const { entities } = this.stateApi.getControlAdaptersState();

    for (const canvasControlAdapter of this.controlAdapters.values()) {
      if (!entities.find((ca) => ca.id === canvasControlAdapter.id)) {
        canvasControlAdapter.destroy();
        this.controlAdapters.delete(canvasControlAdapter.id);
      }
    }

    for (const entity of entities) {
      let adapter = this.controlAdapters.get(entity.id);
      if (!adapter) {
        adapter = new CanvasControlAdapter(entity, this);
        this.controlAdapters.set(adapter.id, adapter);
        this.stage.add(adapter.konva.layer);
      }
      await adapter.render(entity);
    }
  }

  arrangeEntities() {
    const { getLayersState, getControlAdaptersState, getRegionsState } = this.stateApi;
    const layers = getLayersState().entities;
    const controlAdapters = getControlAdaptersState().entities;
    const regions = getRegionsState().entities;
    let zIndex = 0;
    this.background.konva.layer.zIndex(++zIndex);
    this.initialImage.konva.layer.zIndex(++zIndex);
    for (const layer of layers) {
      this.layers.get(layer.id)?.konva.layer.zIndex(++zIndex);
    }
    for (const ca of controlAdapters) {
      this.controlAdapters.get(ca.id)?.konva.layer.zIndex(++zIndex);
    }
    for (const rg of regions) {
      this.regions.get(rg.id)?.konva.layer.zIndex(++zIndex);
    }
    this.inpaintMask.konva.layer.zIndex(++zIndex);
    this.preview.layer.zIndex(++zIndex);
  }

  fitStageToContainer() {
    this.stage.width(this.container.offsetWidth);
    this.stage.height(this.container.offsetHeight);
    this.stateApi.$stageAttrs.set({
      position: { x: this.stage.x(), y: this.stage.y() },
      dimensions: { width: this.stage.width(), height: this.stage.height() },
      scale: this.stage.scaleX(),
    });
    this.background.render();
  }

  getEntity(identifier: CanvasEntityIdentifier): EntityStateAndAdapter | null {
    const state = this.stateApi.getState();

    let entityState: CanvasEntityState | null = null;
    let entityAdapter: CanvasLayer | CanvasRegion | CanvasControlAdapter | CanvasInpaintMask | null = null;

    if (identifier.type === 'layer') {
      entityState = state.layers.entities.find((i) => i.id === identifier.id) ?? null;
      entityAdapter = this.layers.get(identifier.id) ?? null;
    } else if (identifier.type === 'control_adapter') {
      entityState = state.controlAdapters.entities.find((i) => i.id === identifier.id) ?? null;
      entityAdapter = this.controlAdapters.get(identifier.id) ?? null;
    } else if (identifier.type === 'regional_guidance') {
      entityState = state.regions.entities.find((i) => i.id === identifier.id) ?? null;
      entityAdapter = this.regions.get(identifier.id) ?? null;
    } else if (identifier.type === 'inpaint_mask') {
      entityState = state.inpaintMask;
      entityAdapter = this.inpaintMask;
    }

    if (entityState && entityAdapter && entityState.type === entityAdapter.type) {
      return { state: entityState, adapter: entityAdapter } as EntityStateAndAdapter;
    }

    return null;
  }

  getSelectedEntity = () => {
    const state = this.stateApi.getState();
    if (state.selectedEntityIdentifier) {
      return this.getEntity(state.selectedEntityIdentifier);
    }
    return null;
  };

  getCurrentFill = () => {
    const state = this.stateApi.getState();
    let currentFill: RgbaColor = state.tool.fill;
    const selectedEntity = this.getSelectedEntity();
    if (selectedEntity) {
      // These two entity types use a compositing rect for opacity. Their fill is always white.
      if (selectedEntity.state.type === 'regional_guidance' || selectedEntity.state.type === 'inpaint_mask') {
        currentFill = RGBA_WHITE;
      }
    }
    return currentFill;
  };

  getBrushPreviewFill = () => {
    const state = this.stateApi.getState();
    let currentFill: RgbaColor = state.tool.fill;
    const selectedEntity = this.getSelectedEntity();
    if (selectedEntity) {
      // The brush should use the mask opacity for these entity types
      if (selectedEntity.state.type === 'regional_guidance' || selectedEntity.state.type === 'inpaint_mask') {
        currentFill = { ...selectedEntity.state.fill, a: this.stateApi.getSettings().maskOpacity };
      }
    }
    return currentFill;
  };

  getTransformingLayer() {
    const transformingEntity = this.transformingEntity.getValue();
    if (!transformingEntity) {
      return null;
    }

    const { id, type } = transformingEntity;

    if (type === 'layer') {
      return this.layers.get(id) ?? null;
    } else if (type === 'inpaint_mask') {
      return this.inpaintMask;
    }

    return null;
  }

  getIsTransforming() {
    return Boolean(this.transformingEntity.getValue());
  }

  startTransform() {
    if (this.getIsTransforming()) {
      return;
    }
    const layer = this.getSelectedEntity();
    // TODO(psyche): Support other entity types
    assert(
      layer && (layer.adapter instanceof CanvasLayer || layer.adapter instanceof CanvasInpaintMask),
      'No selected layer'
    );
    layer.adapter.transformer.startTransform();
    this.transformingEntity.publish({ id: layer.state.id, type: layer.state.type });
  }

  async applyTransform() {
    const layer = this.getTransformingLayer();
    if (layer) {
      await layer.transformer.applyTransform();
    }
    this.transformingEntity.publish(null);
  }

  cancelTransform() {
    const layer = this.getTransformingLayer();
    if (layer) {
      layer.transformer.stopTransform();
    }
    this.transformingEntity.publish(null);
  }

  render = async () => {
    const state = this.stateApi.getState();

    if (this._prevState === state && !this._isFirstRender) {
      this.log.trace('No changes detected, skipping render');
      return;
    }

    if (this._isFirstRender || state.layers.entities !== this._prevState.layers.entities) {
      this.log.debug('Rendering layers');

      for (const canvasLayer of this.layers.values()) {
        if (!state.layers.entities.find((l) => l.id === canvasLayer.id)) {
          await canvasLayer.destroy();
          this.layers.delete(canvasLayer.id);
        }
      }

      for (const entityState of state.layers.entities) {
        let adapter = this.layers.get(entityState.id);
        if (!adapter) {
          adapter = new CanvasLayer(entityState, this);
          this.layers.set(adapter.id, adapter);
          this.stage.add(adapter.konva.layer);
        }
        await adapter.update({
          state: entityState,
          toolState: state.tool,
          isSelected: state.selectedEntityIdentifier?.id === entityState.id,
        });
      }
    }

    if (
      this._isFirstRender ||
      state.initialImage !== this._prevState.initialImage ||
      state.bbox.rect !== this._prevState.bbox.rect ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering initial image');
      await this.renderInitialImage();
    }

    if (
      this._isFirstRender ||
      state.regions.entities !== this._prevState.regions.entities ||
      state.settings.maskOpacity !== this._prevState.settings.maskOpacity ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering regions');
      await this.renderRegions();
    }

    if (
      this._isFirstRender ||
      state.inpaintMask !== this._prevState.inpaintMask ||
      state.settings.maskOpacity !== this._prevState.settings.maskOpacity ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering inpaint mask');
      await this.inpaintMask.update({
        state: state.inpaintMask,
        toolState: state.tool,
        isSelected: state.selectedEntityIdentifier?.id === state.inpaintMask.id,
      });
    }

    if (
      this._isFirstRender ||
      state.controlAdapters.entities !== this._prevState.controlAdapters.entities ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering control adapters');
      await this.renderControlAdapters();
    }

    this.toolState.publish(state.tool);
    this.selectedEntityIdentifier.publish(state.selectedEntityIdentifier);
    this.selectedEntity.publish(this.getSelectedEntity());
    this.currentFill.publish(this.getCurrentFill());

    if (
      this._isFirstRender ||
      state.bbox !== this._prevState.bbox ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.session.isActive !== this._prevState.session.isActive
    ) {
      this.log.debug('Rendering generation bbox');
      await this.preview.bbox.render();
    }

    if (
      this._isFirstRender ||
      state.layers !== this._prevState.layers ||
      state.controlAdapters !== this._prevState.controlAdapters ||
      state.regions !== this._prevState.regions
    ) {
      // this.log.debug('Updating entity bboxes');
      // debouncedUpdateBboxes(stage, canvasV2.layers, canvasV2.controlAdapters, canvasV2.regions, onBboxChanged);
    }

    if (this._isFirstRender || state.session !== this._prevState.session) {
      this.log.debug('Rendering staging area');
      await this.preview.stagingArea.render();
    }

    if (
      this._isFirstRender ||
      state.layers.entities !== this._prevState.layers.entities ||
      state.controlAdapters.entities !== this._prevState.controlAdapters.entities ||
      state.regions.entities !== this._prevState.regions.entities ||
      state.inpaintMask !== this._prevState.inpaintMask ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Arranging entities');
      await this.arrangeEntities();
    }

    this._prevState = state;

    if (this._isFirstRender) {
      this._isFirstRender = false;
    }
  };

  initialize = () => {
    this.log.debug('Initializing renderer');
    this.stage.container(this.container);

    const unsubscribeListeners = setStageEventHandlers(this);

    // We can use a resize observer to ensure the stage always fits the container. We also need to re-render the bg and
    // document bounds overlay when the stage is resized.
    const resizeObserver = new ResizeObserver(this.fitStageToContainer.bind(this));
    resizeObserver.observe(this.container);
    this.fitStageToContainer();

    const unsubscribeRenderer = this._store.subscribe(this.render);

    // When we this flag, we need to render the staging area
    const unsubscribeShouldShowStagedImage = $shouldShowStagedImage.subscribe(
      async (shouldShowStagedImage, prevShouldShowStagedImage) => {
        if (shouldShowStagedImage !== prevShouldShowStagedImage) {
          this.log.debug('Rendering staging area');
          await this.preview.stagingArea.render();
        }
      }
    );

    const unsubscribeLastProgressEvent = $lastProgressEvent.subscribe(
      async (lastProgressEvent, prevLastProgressEvent) => {
        if (lastProgressEvent !== prevLastProgressEvent) {
          this.log.debug('Rendering progress image');
          await this.preview.progressPreview.render(lastProgressEvent);
        }
      }
    );

    this.log.debug('First render of konva stage');
    this.preview.tool.render();
    this.render();

    return () => {
      this.log.debug('Cleaning up konva renderer');
      unsubscribeRenderer();
      unsubscribeListeners();
      unsubscribeShouldShowStagedImage();
      unsubscribeLastProgressEvent();
      resizeObserver.disconnect();
    };
  };

  getStageScale(): number {
    // The stage is never scaled differently in x and y
    return this.stage.scaleX();
  }

  getStagePosition(): Coordinate {
    return this.stage.position();
  }

  getScaledPixel(): number {
    return 1 / this.getStageScale();
  }

  getScaledBboxPadding(): number {
    return CanvasManager.BBOX_PADDING_PX / this.getStageScale();
  }

  getTransformerPadding(): number {
    return CanvasManager.BBOX_PADDING_PX;
  }

  getGenerationMode(): GenerationMode {
    const session = this.stateApi.getSession();
    if (session.isActive) {
      return getGenerationMode({ manager: this });
    }

    const initialImageState = this.stateApi.getInitialImageState();

    if (initialImageState.imageObject && initialImageState.isEnabled) {
      return 'img2img';
    }

    return 'txt2img';
  }

  getControlAdapterImage(arg: Omit<Parameters<typeof getControlAdapterImage>[0], 'manager'>) {
    return getControlAdapterImage({ ...arg, manager: this });
  }

  getRegionMaskImage(arg: Omit<Parameters<typeof getRegionMaskImage>[0], 'manager'>) {
    return getRegionMaskImage({ ...arg, manager: this });
  }

  getInpaintMaskImage(arg: Omit<Parameters<typeof getInpaintMaskImage>[0], 'manager'>) {
    return getInpaintMaskImage({ ...arg, manager: this });
  }

  getInitialImage(arg: Omit<Parameters<typeof getCompositeLayerImage>[0], 'manager'>) {
    if (this.stateApi.getSession().isActive) {
      return getCompositeLayerImage({ ...arg, manager: this });
    } else {
      return getInitialImage({ ...arg, manager: this });
    }
  }

  getLoggingContext() {
    return {
      // timestamp: new Date().toISOString(),
    };
  }

  buildLogger(getContext: () => JSONObject): Logger {
    return this.log.child((message) => {
      return {
        ...message,
        context: {
          ...message.context,
          ...getContext(),
        },
      };
    });
  }

  buildGetLoggingContext = (
    instance:
      | CanvasBrushLineRenderer
      | CanvasEraserLineRenderer
      | CanvasRectRenderer
      | CanvasImageRenderer
      | CanvasTransformer
      | CanvasObjectRenderer
      | CanvasLayer
      | CanvasInpaintMask
      | CanvasStagingArea
  ): GetLoggingContext => {
    if (
      instance instanceof CanvasLayer ||
      instance instanceof CanvasStagingArea ||
      instance instanceof CanvasInpaintMask
    ) {
      return (extra?: JSONObject): JSONObject => {
        return {
          ...instance.manager.getLoggingContext(),
          entityId: instance.id,
          ...extra,
        };
      };
    } else if (instance instanceof CanvasObjectRenderer) {
      return (extra?: JSONObject): JSONObject => {
        return {
          ...instance.parent.getLoggingContext(),
          rendererId: instance.id,
          ...extra,
        };
      };
    } else {
      return (extra?: JSONObject): JSONObject => {
        return {
          ...instance.parent.getLoggingContext(),
          objectId: instance.id,
          ...extra,
        };
      };
    }
  };

  logDebugInfo() {
    // eslint-disable-next-line no-console
    console.log(this);
    for (const layer of this.layers.values()) {
      // eslint-disable-next-line no-console
      console.log(layer);
    }
  }

  getPrefixedId = getPrefixedId;
}
