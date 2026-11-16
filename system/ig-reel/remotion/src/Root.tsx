/**
 * Remotion root. The default props are a deliberately fictitious, neutral
 * placeholder ("Example" in the invented "Puerto Ejemplo", coordinates around
 * 0,0) so the studio opens without any real profile on disk. Real renders
 * always pass full props via `--props`; `calculateMetadata` re-derives the
 * duration from however many items those props carry.
 */

import React from 'react';
import { Composition } from 'remotion';

import { Reel } from './Reel';
import type { ReelProps } from './props';
import { CANVAS_HEIGHT, CANVAS_WIDTH, FPS, scenesFor, totalFrames, totalFramesOf } from './timeline';
import { MAP_ATTRIBUTION } from './maplibre';

const defaultProps: ReelProps = {
  locale: 'en',
  colors: {
    accent: '#3b6ea5',
    surface: '#f4f5f7',
    onSurface: '#2b3440',
    onSurfaceMuted: '#6b7280',
    wordmark: '#31517a',
    orbA: 'rgba(170, 190, 215, 0.5)',
    orbB: 'rgba(140, 165, 200, 0.45)',
    labelPlate: 'rgba(244, 245, 247, 0.88)',
    credit: 'rgba(43, 52, 64, 0.64)',
    pulse: 'rgba(59, 110, 165, 0.72)',
  },
  coverGradient: 'linear-gradient(180deg, #5a7fa8, #3b6ea5, #2f5a88)',
  fonts: {
    body: 'Inter',
    logo: 'cursive',
  },
  copy: {
    coverTitle: 'Agenda',
    coverSubtitle: 'in Example Harbor',
    coverCount: '2 plans this week',
    closingCta: 'Find out more at',
    wordmark: 'Example',
    site: 'example.test',
  },
  attribution: MAP_ATTRIBUTION,
  map: {
    center: [0, 0],
    zoom: 11.35,
    span: [0.08, 0.06],
  },
  items: [
    {
      title: 'Example concert in the square',
      when: 'Thu 1 Jan · 20:00',
      where: 'Central Square, 123 Example St',
      mapLabel: 'Central Square',
      category: 'MUSIC',
      categoryBackground: '#3b6ea5',
      image: 'assets/example-1.jpg',
      lng: 0.01,
      lat: 0.008,
    },
    {
      title: 'Example fair by the pier',
      when: 'Fri 2 Jan · 12:00',
      where: 'Old Pier, 45 Harbor Ave',
      mapLabel: 'Old Pier',
      category: '',
      categoryBackground: '',
      image: 'assets/example-2.jpg',
      lng: -0.012,
      lat: -0.006,
    },
  ],
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel}
    width={CANVAS_WIDTH}
    height={CANVAS_HEIGHT}
    fps={FPS}
    durationInFrames={totalFrames(defaultProps.items.length)}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({
      // Scenes, when the Node side derived them from a storyboard; the fixed
      // rhythm otherwise — the same frame count as before scenes existed.
      // `showMap` matters here too: without a storyboard there are no derived
      // scenes to defer to, and the fixed rhythm has to drop the same flights
      // the composition will. Miss it and the video is one flight per item
      // too long — a tail of frames after the closing has ended.
      durationInFrames: totalFramesOf(
        scenesFor(props.items.length, props.scenes, props.showMap !== false),
      ),
    })}
  />
);
