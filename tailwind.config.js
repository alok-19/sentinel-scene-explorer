/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#040d1a',
        cyan: '#00d4ff',
      },
      boxShadow: {
        cyan: '0 0 0 1px rgba(0, 212, 255, 0.2), 0 18px 48px rgba(0, 0, 0, 0.32)',
      },
    },
  },
  plugins: [],
};
