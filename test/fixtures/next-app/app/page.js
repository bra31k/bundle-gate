'use client';

import chunk from 'lodash/chunk';

export default function Home() {
  const rows = chunk([1, 2, 3, 4, 5, 6], 2);
  return (
    <main>
      <h1>Home</h1>
      <p>{rows.length} rows</p>
    </main>
  );
}
