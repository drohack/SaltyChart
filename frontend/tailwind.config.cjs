/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,svelte,ts}'],
  theme: {
    extend: {
      screens: {
        // Threshold for 1 column: card width (610px) + margins (256px*2) = 1122px
        '2cols': '1122px',
        // Threshold for 2 columns: 2*card (610px*2) + margins (256px*2) = 1732px
        '3cols': '1732px',
      }
    }
  },
  plugins: [require('daisyui')]
};
