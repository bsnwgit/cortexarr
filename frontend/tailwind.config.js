/** @type {import('tailwindcss').Config} */
//
// Cortexarr's own theme — deliberately not the pkt* suite's warm-ink/gold
// palette. Distinct product, distinct visual identity; the shared bsnw
// architecture is followed at the layout/tab-structure level (see
// src/components/Layout.tsx), not by remapping this suite's palette onto
// pkt*'s naming scheme.
//
// Cool near-black slate field, violet as the primary/active channel (a nod
// to "Cortex"), teal as the secondary/data channel. Rounded corners and soft
// shadows for a smoother, less hairline-geometric feel than the pkt* suite.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: {
          925: '#0d1220',
          950: '#080b14',
        },
        violet: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        teal: {
          400: '#2dd4bf',
          500: '#14b8a6',
        },
      },
      borderRadius: {
        xl: '0.875rem',
      },
    },
  },
  plugins: [],
}
