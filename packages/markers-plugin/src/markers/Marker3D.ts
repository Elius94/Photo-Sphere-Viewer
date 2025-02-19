import { ExtendedPosition, PSVError, Point, Size, utils, type Viewer } from '@photo-sphere-viewer/core';
import {
    BufferGeometry,
    Group,
    Mesh,
    Object3D,
    PlaneGeometry,
    ShaderMaterial,
    Texture,
    Vector3,
    VideoTexture,
} from 'three';
import { ChromaKeyMaterial } from '../../../shared/ChromaKeyMaterial';
import { createVideo } from '../../../shared/video-utils';
import { MarkerType } from '../MarkerType';
import { type MarkersPlugin } from '../MarkersPlugin';
import { MARKER_DATA } from '../constants';
import { MarkerConfig } from '../model';
import { getPolygonCenter } from '../utils';
import { Marker } from './Marker';

/**
 * @internal
 */
export class Marker3D extends Marker {
    override get threeElement(): Mesh<BufferGeometry, ShaderMaterial> {
        return this.element;
    }

    override get video(): HTMLVideoElement {
        if (this.type === MarkerType.videoLayer) {
            return (this.threeElement.material as ChromaKeyMaterial).map.image;
        } else {
            return null;
        }
    }

    constructor(viewer: Viewer, plugin: MarkersPlugin, config: MarkerConfig) {
        super(viewer, plugin, config);
    }

    override is3d(): boolean {
        return true;
    }

    override createElement(): void {
        const material = new ChromaKeyMaterial({ alpha: 0 });
        const geometry = new PlaneGeometry(1, 1);
        const mesh = new Mesh(geometry, material);
        mesh.userData = { [MARKER_DATA]: this };
        const group = new Group().add(mesh);

        // overwrite the visible property to be tied to the Marker instance
        // and do it without context bleed
        Object.defineProperty(group, 'visible', {
            enumerable: true,
            get: function (this: Object3D) {
                return (this.children[0].userData[MARKER_DATA] as Marker).state.visible;
            },
            set: function (this: Object3D, visible: boolean) {
                (this.children[0].userData[MARKER_DATA] as Marker).state.visible = visible;
            },
        });

        this.element = mesh;

        if (this.type === MarkerType.videoLayer) {
            this.viewer.needsContinuousUpdate(true);
        }
    }

    override destroy(): void {
        delete this.threeElement.userData[MARKER_DATA];

        if (this.type === MarkerType.videoLayer) {
            this.video.pause();
            this.viewer.needsContinuousUpdate(false);
        }

        super.destroy();
    }

    override render(): Point {
        if (this.viewer.renderer.isObjectVisible(this.threeElement)) {
            return this.viewer.dataHelper.sphericalCoordsToViewerCoords(this.state.position);
        } else {
            return null;
        }
    }

    override update(config: MarkerConfig): void {
        super.update(config);

        const mesh = this.threeElement;
        const group = mesh.parent;
        const material = mesh.material as ChromaKeyMaterial;

        this.state.dynamicSize = false;

        if (utils.isExtendedPosition(this.config.position)) {
            if (!this.config.size) {
                throw new PSVError('missing marker size');
            }

            this.state.position = this.viewer.dataHelper.cleanPosition(this.config.position);
            this.state.size = this.config.size;

            mesh.position.set(0.5 - this.state.anchor.x, this.state.anchor.y - 0.5, 0);
            this.viewer.dataHelper.sphericalCoordsToVector3(this.state.position, group.position);

            group.lookAt(0, group.position.y, 0);
            switch (this.config.orientation) {
                case 'horizontal':
                    group.rotateX(this.state.position.pitch < 0 ? -Math.PI / 2 : Math.PI / 2);
                    break;
                case 'vertical-left':
                    group.rotateY(-Math.PI * 0.4);
                    break;
                case 'vertical-right':
                    group.rotateY(Math.PI * 0.4);
                    break;
                // no default
            }

            // 100 is magic number that gives a coherent size at default zoom level
            group.scale.set(this.config.size.width / 100, this.config.size.height / 100, 1);

            const p = mesh.geometry.getAttribute('position');
            this.state.positions3D = [0, 1, 3, 2].map((i) => {
                const v3 = new Vector3();
                v3.fromBufferAttribute(p, i);
                return mesh.localToWorld(v3);
            });
        } else {
            if (this.config.position?.length !== 4) {
                throw new PSVError('missing marker position');
            }

            const positions = this.config.position.map((p) => this.viewer.dataHelper.cleanPosition(p));
            const positions3D = positions.map((p) => this.viewer.dataHelper.sphericalCoordsToVector3(p));

            const centroid = getPolygonCenter(positions.map(({ yaw, pitch }) => [yaw, pitch]));
            this.state.position = { yaw: centroid[0], pitch: centroid[1] };

            this.state.positions3D = positions3D;

            const p = mesh.geometry.getAttribute('position');
            [
                positions3D[0],
                positions3D[1],
                positions3D[3], // not a mistake!
                positions3D[2],
            ].forEach((v, i) => {
                p.setX(i, v.x);
                p.setY(i, v.y);
                p.setZ(i, v.z);
            });
            p.needsUpdate = true;

            this.__setTextureWrap(material);
        }

        switch (this.type) {
            case MarkerType.videoLayer:
                if (this.definition !== this.config.videoLayer) {
                    material.map?.dispose();

                    const video = createVideo({
                        src: this.config.videoLayer,
                        withCredentials: this.viewer.config.withCredentials,
                        muted: true,
                        autoplay: true,
                    });

                    const texture = new VideoTexture(video);
                    material.map = texture;
                    material.alpha = 0;

                    video.addEventListener('loadedmetadata', () => {
                        material.alpha = this.config.opacity;

                        if (!utils.isExtendedPosition(this.config.position)) {
                            mesh.material.userData[MARKER_DATA] = { width: video.videoWidth, height: video.videoHeight };
                            this.__setTextureWrap(material);
                        }
                    }, { once: true });

                    video.play();

                    this.definition = this.config.videoLayer;
                }
                break;

            case MarkerType.imageLayer:
                if (this.definition !== this.config.imageLayer) {
                    material.map?.dispose();

                    const texture = new Texture();
                    material.map = texture;
                    material.alpha = 0;

                    this.viewer.textureLoader.loadImage(this.config.imageLayer).then((image) => {
                        if (!utils.isExtendedPosition(this.config.position)) {
                            mesh.material.userData[MARKER_DATA] = { width: image.width, height: image.height };
                            this.__setTextureWrap(material);
                        }

                        texture.image = image;
                        texture.anisotropy = 4;
                        texture.needsUpdate = true;
                        material.alpha = this.config.opacity;

                        this.viewer.needsUpdate();
                    });

                    this.definition = this.config.imageLayer;
                }
                break;

            // no default
        }

        material.chromaKey = this.config.chromaKey;
        mesh.renderOrder = 1000 + this.config.zIndex;
        mesh.geometry.boundingBox = null; // reset box for Renderer.isObjectVisible
    }

    /**
     * For layers positionned by corners, applies offset to the texture in order to keep its proportions
     */
    private __setTextureWrap(material: ChromaKeyMaterial) {
        const imageSize: Size = material.userData[MARKER_DATA];

        if (!imageSize || !imageSize.height || !imageSize.width) {
            material.repeat.set(1, 1);
            material.offset.set(0, 0);
            return;
        }

        const positions = (this.config.position as ExtendedPosition[]).map((p) => {
            return this.viewer.dataHelper.cleanPosition(p);
        });

        const w1 = utils.greatArcDistance(
            [positions[0].yaw, positions[0].pitch],
            [positions[1].yaw, positions[1].pitch]
        );
        const w2 = utils.greatArcDistance(
            [positions[3].yaw, positions[3].pitch],
            [positions[2].yaw, positions[2].pitch]
        );
        const h1 = utils.greatArcDistance(
            [positions[1].yaw, positions[1].pitch],
            [positions[2].yaw, positions[2].pitch]
        );
        const h2 = utils.greatArcDistance(
            [positions[0].yaw, positions[0].pitch],
            [positions[3].yaw, positions[3].pitch]
        );

        const layerRatio = (w1 + w2) / (h1 + h2);
        const imageRatio = imageSize.width / imageSize.height;

        let hMargin = 0;
        let vMargin = 0;
        if (layerRatio < imageRatio) {
            hMargin = imageRatio - layerRatio;
        } else {
            vMargin = 1 / imageRatio - 1 / layerRatio;
        }

        material.repeat.set(1 - hMargin, 1 - vMargin);
        material.offset.set(hMargin / 2, vMargin / 2);
    }
}
