'use client';

import { useState } from 'react';

export default function Shop() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Shop</h1>
      <button onClick={() => setCount(count + 1)}>Cart: {count}</button>
    </main>
  );
}
