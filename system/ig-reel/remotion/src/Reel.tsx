/**
 * The reel composition: cover → (map scene + item card) per item → closing.
 *
 * Everything visual that identifies a brand — colors, fonts, copy, gradient,
 * coordinates, images — arrives resolved in `ReelProps` and is applied through
 * CSS custom properties or inline styles. This file owns only structure and
 * motion; see `timeline.ts` for the shared timing/camera math.
 */

import React, { useEffect, useMemo } from 'react';
import {
  AbsoluteFill,
  Img,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

import { MAP_ATTRIBUTION, useMapLibre } from './maplibre';
import type { ReelProps, ReelPropsItem } from './props';
import {
  COVER_EXIT_TAIL,
  LABEL_IN_SECONDS,
  PIN_DROP_SECONDS,
  PIN_SETTLE_SECONDS,
  TIMING,
  cameraAt,
  clamp01,
  closingScene,
  coverScene,
  itemScenes,
  lerp,
  opacityBetween,
  scenesFor,
  type Scene,
} from './timeline';
import './style.css';

const resolveImageSrc = (image: string): string =>
  /^https?:\/\//i.test(image) ? image : staticFile(image);

const Pin: React.FC<{ progress: number; visible: boolean; accent: string }> = ({
  progress,
  visible,
  accent,
}) => (
  <div
    className="reelPinWrap"
    style={{
      opacity: visible ? 1 : 0,
      transform: `translate(-50%, -100%) translateY(${lerp(-130, 0, progress)}px) scale(${lerp(0.72, 1, progress)})`,
    }}
  >
    <span
      className="reelPinPulse"
      style={{
        opacity: interpolate(progress, [0.3, 1], [0.75, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        }),
        transform: `translate(-50%, -50%) scale(${lerp(0.25, 1.45, progress)})`,
      }}
    />
    <svg className="reelPin" viewBox="0 0 96 128" aria-hidden="true">
      <path
        d="M48 4C24.3 4 6 22.4 6 46.1c0 32.4 42 77.9 42 77.9s42-45.5 42-77.9C90 22.4 71.7 4 48 4Z"
        fill={accent}
      />
      <circle cx="48" cy="46" r="18" fill="#fff" />
    </svg>
  </div>
);

const Cover: React.FC<{ seconds: number; scene: Scene; copy: ReelProps['copy'] }> = ({
  seconds,
  scene,
  copy,
}) => {
  // The rise runs over the engine's cover rhythm, not over a narration-
  // stretched duration: a longer cover holds the settled frame, it does not
  // slow the motion down.
  const rise = clamp01(seconds / TIMING.cover);
  const textEnd = scene.end + COVER_EXIT_TAIL;

  return (
    <AbsoluteFill className="reelCover">
      <div className="reelCoverFill" style={{ transform: `translateY(${-104 * rise}px)` }} />
      <span
        className="reelOrb reelOrbA"
        style={{ transform: `translate(${42 * rise}px, ${-56 * rise}px)` }}
      />
      <span
        className="reelOrb reelOrbB"
        style={{ transform: `translate(${-38 * rise}px, ${-70 * rise}px)` }}
      />
      <div className="reelCoverWrap">
        <span className="reelScript" style={{ opacity: opacityBetween(seconds, 0.1, textEnd, 0.8) }}>
          {copy.coverTitle}
        </span>
        <span
          className="reelCoverSub"
          style={{ opacity: opacityBetween(seconds, 0.32, textEnd, 0.6) }}
        >
          {copy.coverSubtitle}
        </span>
        <span
          className="reelCoverBar"
          style={{
            transform: `scaleX(${interpolate(seconds, [0.55, 1.95], [0, 1.35], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })})`,
          }}
        />
        <span
          className="reelCoverCount"
          style={{ opacity: opacityBetween(seconds, 0.75, textEnd, 0.5) }}
        >
          {copy.coverCount}
        </span>
      </div>
      <span
        className="reelCoverWord"
        style={{ opacity: opacityBetween(seconds, 0.95, textEnd + 0.2, 0.5) }}
      >
        {copy.wordmark}
      </span>
    </AbsoluteFill>
  );
};

const MapScene: React.FC<{
  item: ReelPropsItem;
  scene: Scene;
  seconds: number;
  fps: number;
  accent: string;
  attribution: string;
}> = ({ item, scene, seconds, fps, accent, attribution }) => {
  // The camera move is fixed-length whatever the scene lasts: narration time
  // goes to the item card's hold, never to the flight.
  const start = scene.start;
  const pinProgress = spring({
    frame: Math.round((seconds - start - PIN_DROP_SECONDS) * fps),
    fps,
    config: { damping: 15, mass: 0.6, stiffness: 120 },
    durationInFrames: Math.round(PIN_SETTLE_SECONDS * fps),
  });
  const labelOpacity = opacityBetween(seconds, start + LABEL_IN_SECONDS, start + 2.35, 0.4);

  return (
    <AbsoluteFill
      className="reelMapScene"
      style={{ opacity: opacityBetween(seconds, start, start + TIMING.map + TIMING.overlap) }}
    >
      <Pin progress={clamp01(pinProgress)} visible={seconds >= start + PIN_DROP_SECONDS} accent={accent} />
      <div
        className="reelMapLabel"
        style={{
          opacity: labelOpacity,
          transform: `translateX(-50%) translateY(${lerp(22, 0, labelOpacity)}px)`,
        }}
      >
        {item.mapLabel}
      </div>
      <span className="reelMapCredit">{attribution}</span>
    </AbsoluteFill>
  );
};

const EventSlide: React.FC<{
  item: ReelPropsItem;
  index: number;
  scene: Scene;
  seconds: number;
  wordmark: string;
}> = ({ item, index, scene, seconds, wordmark }) => {
  const start = scene.start + TIMING.map;
  // The card holds for whatever the scene has left after the map: the engine
  // minimum, or longer when the narration needs it.
  const hold = scene.duration - TIMING.map;
  const local = clamp01((seconds - start) / hold);
  // Ken Burns: alternate the drift direction per item so the cut feels edited.
  const imageScale = index % 2 === 0 ? lerp(1, 1.16, local) : lerp(1.16, 1, local);

  return (
    <AbsoluteFill
      className="reelEvent"
      style={{ opacity: opacityBetween(seconds, start, start + hold + TIMING.overlap) }}
    >
      <div className="reelPosterZone">
        <Img
          className="reelPoster"
          src={resolveImageSrc(item.image)}
          style={{ transform: `scale(${imageScale})` }}
        />
        <div className="reelPosterFade" />
        {item.category !== '' ? (
          <span className="reelChip" style={{ background: item.categoryBackground }}>
            {item.category}
          </span>
        ) : null}
      </div>
      <div className="reelBand">
        <span className="reelTitle">{item.title}</span>
        <span className="reelBar" />
        <span className="reelWhen">{item.when}</span>
        <span className="reelWhere">{item.where}</span>
        <span className="reelWordmark">{wordmark}</span>
      </div>
    </AbsoluteFill>
  );
};

const Closing: React.FC<{ seconds: number; scene: Scene; copy: ReelProps['copy'] }> = ({
  seconds,
  scene,
  copy,
}) => {
  const start = scene.start;
  const local = seconds - start;

  return (
    <AbsoluteFill
      className="reelClose"
      style={{ opacity: opacityBetween(seconds, start, scene.end) }}
    >
      <div className="reelCloseWrap">
        <span className="reelCloseWord" style={{ opacity: opacityBetween(local, 0.1, 3, 0.6) }}>
          {copy.wordmark}
        </span>
        <span className="reelCloseCta" style={{ opacity: opacityBetween(local, 0.4, 3, 0.4) }}>
          {copy.closingCta}
        </span>
        <span
          className="reelCloseSite"
          style={{
            opacity: opacityBetween(local, 0.6, 3, 0.5),
            transform: `translateY(${lerp(24, 0, clamp01((local - 0.6) / 0.5))}px) scale(${lerp(1, 1.05, clamp01((local - 1) / 1))})`,
          }}
        >
          {copy.site}
        </span>
      </div>
    </AbsoluteFill>
  );
};

export const Reel: React.FC<ReelProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;

  // Hold the first frames until the document's fonts are ready, so the cover
  // never captures with the fallback face. A 3s safety timeout keeps a font
  // that never loads from stalling the render; continueRender twice is a
  // tolerated no-op, so the cleanup can release unconditionally.
  useEffect(() => {
    const handle = delayRender('fonts');
    const timeout = window.setTimeout(() => continueRender(handle), 3000);
    document.fonts.ready.then(() => continueRender(handle));
    return () => {
      window.clearTimeout(timeout);
      continueRender(handle);
    };
  }, []);

  // The prop exists to EXTEND the basemap credit, never to turn it off: an
  // empty or whitespace attribution falls back to the engine's MAP_ATTRIBUTION.
  const attribution = props.attribution.trim() || MAP_ATTRIBUTION;

  // Without a storyboard this is the fixed rhythm — the same frames as before
  // scenes existed. With one, every scene already carries its derived timing.
  const scenes = useMemo(
    () => scenesFor(props.items.length, props.scenes),
    [props.items.length, props.scenes],
  );
  const camera = useMemo(
    () => cameraAt(seconds, props.map, props.items, scenes),
    [seconds, props.map, props.items, scenes],
  );
  const { containerRef, loaded } = useMapLibre(camera);

  const logoFont = props.logoFontFile ? `"ReelLogo", ${props.fonts.logo}` : props.fonts.logo;

  const cssVars = {
    '--accent': props.colors.accent,
    '--surface': props.colors.surface,
    '--on-surface': props.colors.onSurface,
    '--on-surface-muted': props.colors.onSurfaceMuted,
    '--wordmark': props.colors.wordmark,
    '--orb-a': props.colors.orbA,
    '--orb-b': props.colors.orbB,
    '--label-plate': props.colors.labelPlate,
    '--credit': props.colors.credit,
    '--pulse': props.colors.pulse,
    '--cover-gradient': props.coverGradient,
    '--font-body': props.fonts.body,
    '--font-logo': logoFont,
  } as React.CSSProperties;

  const cover = coverScene(scenes);
  const closing = closingScene(scenes);
  const items = itemScenes(scenes);

  return (
    <AbsoluteFill className="reelScene" style={{ ...cssVars, background: 'var(--surface)' }}>
      {props.logoFontFile ? (
        <style>{`@font-face { font-family: "ReelLogo"; font-style: normal; font-weight: 400; src: url("${staticFile(props.logoFontFile)}") format("woff2"); }`}</style>
      ) : null}
      <div className="reelBackground" />
      <div ref={containerRef} className="reelMap" />
      <div className="reelMapWash" />
      {!loaded ? <div className="reelLoading">Loading map</div> : null}
      {cover && seconds < cover.end + COVER_EXIT_TAIL ? (
        <Cover seconds={seconds} scene={cover} copy={props.copy} />
      ) : null}
      {items.map((scene, index) => {
        const item = props.items[scene.itemIndex ?? index];
        if (!item) return null;
        return (
          <React.Fragment key={`${item.title}-${index}`}>
            <MapScene
              item={item}
              scene={scene}
              seconds={seconds}
              fps={fps}
              accent={props.colors.accent}
              attribution={attribution}
            />
            <EventSlide
              item={item}
              index={index}
              scene={scene}
              seconds={seconds}
              wordmark={props.copy.wordmark}
            />
          </React.Fragment>
        );
      })}
      {closing && seconds >= closing.start - TIMING.overlap ? (
        <Closing seconds={seconds} scene={closing} copy={props.copy} />
      ) : null}
    </AbsoluteFill>
  );
};
