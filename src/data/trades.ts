import type { Trade } from './types';

export const trades: Trade[] = [
  { name: 'HVAC', slug: 'hvac', icon: '❄️', toolCount: 24, status: 'live' },
  { name: 'Electrical', slug: 'electrical', icon: '⚡', toolCount: 24, status: 'live' },
  { name: 'Roofing', slug: 'roofing', icon: '🏠', toolCount: 24, status: 'live' },
  { name: 'Painting', slug: 'painting', icon: '🖌️', toolCount: 24, status: 'live' },
  { name: 'Landscaping', slug: 'landscaping', icon: '🌿', toolCount: 24, status: 'live' },
  { name: 'General Contractor', slug: 'gc', icon: '🛠️', toolCount: 24, status: 'live' },
  { name: 'Handyman', slug: 'handyman', icon: '🧰', toolCount: 24, status: 'live' },
  { name: 'Pest Control', slug: 'pest-control', icon: '🐛', toolCount: 24, status: 'live' },
  { name: 'Cleaning', slug: 'cleaning', icon: '✨', toolCount: 24, status: 'live' },
  { name: 'Plumbing', slug: 'plumbing', icon: '🔧', toolCount: 24, status: 'live' },
];

export function getTradeBySlug(slug: string): Trade | undefined {
  return trades.find(t => t.slug === slug);
}

export function getLiveTrades(): Trade[] {
  return trades.filter(t => t.status === 'live');
}
