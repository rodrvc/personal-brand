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
import { CANVAS_HEIGHT, CANVAS_WIDTH, FPS, totalFrames } from './timeline';
import { MAP_ATTRIBUTION } from './maplibre';

const defaultProps: ReelProps = {
  locale: 'es',
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
    coverSubtitle: 'en Puerto Ejemplo',
    coverCount: '2 planes de la semana',
    closingCta: 'Descubre más en',
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
      title: 'Concierto de ejemplo en la plaza',
      when: 'Jue 1 Ene · 20:00',
      where: 'Plaza Central, Calle Falsa 123',
      mapLabel: 'Plaza Central',
      category: 'MÚSICA',
      categoryBackground: '#3b6ea5',
      image: 'assets/example-1.jpg',
      lng: 0.01,
      lat: 0.008,
    },
    {
      title: 'Feria de ejemplo junto al muelle',
      when: 'Vie 2 Ene · 12:00',
      where: 'Muelle Viejo, Av. del Puerto 45',
      mapLabel: 'Muelle Viejo',
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
      durationInFrames: totalFrames(props.items.length),
    })}
  />
);
