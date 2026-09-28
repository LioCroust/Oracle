export interface TarotCard {
  id: number;
  name: string;
  theme: string;
  symbol: string; // Unicode or symbolic character for visual
  upright: string;
  reversed: string;
  color: string; // accent color for the card
  image: any; // local tarot card illustration
}

export const TAROT_CARDS: TarotCard[] = [
  {
    id: 1,
    name: "Le Mat",
    theme: "Commencements",
    symbol: "✦",
    upright: "Liberté, nouveaux départs, spontanéité, aventure",
    reversed: "Imprudence, manque de direction, risque mal calculé",
    color: "#A8C9A0",
    image: require("../assets/images/cards/card-1.png"),
  },
  {
    id: 2,
    name: "La Prêtresse",
    theme: "Intuition",
    symbol: "☽",
    upright: "Sagesse intérieure, mystère, intuition, connaissance cachée",
    reversed: "Secrets nocifs, confusion, refus d'écouter son intuition",
    color: "#8B7CC8",
    image: require("../assets/images/cards/card-2.png"),
  },
  {
    id: 3,
    name: "L'Impératrice",
    theme: "Abondance",
    symbol: "♀",
    upright: "Fertilité, créativité, abondance, nature, maternité",
    reversed: "Dépendance, stagnation, manque de croissance",
    color: "#C9A884",
    image: require("../assets/images/cards/card-3.png"),
  },
  {
    id: 4,
    name: "L'Empereur",
    theme: "Autorité",
    symbol: "♦",
    upright: "Structure, autorité, stabilité, leadership, maîtrise",
    reversed: "Rigidité, contrôle excessif, tyrannie, immaturité",
    color: "#C97A4C",
    image: require("../assets/images/cards/card-4.png"),
  },
  {
    id: 5,
    name: "Le Soleil",
    theme: "Réussite",
    symbol: "☀",
    upright: "Joie, succès, vitalité, clarté, épanouissement",
    reversed: "Pessimisme, manque de clarté, succès retardé",
    color: "#C9C44C",
    image: require("../assets/images/cards/card-5.png"),
  },
  {
    id: 6,
    name: "La Lune",
    theme: "Illusions",
    symbol: "◉",
    upright: "Rêves, intuition profonde, inconscient, cycles, illusions",
    reversed: "Tromperie, peurs cachées, confusion, anxiété",
    color: "#7CA8C8",
    image: require("../assets/images/cards/card-6.png"),
  },
  {
    id: 7,
    name: "L'Étoile",
    theme: "Espoir",
    symbol: "★",
    upright: "Espoir, inspiration, renouveau, guérison, confiance",
    reversed: "Désespoir, manque de foi, découragement, perte d'inspiration",
    color: "#C9A84C",
    image: require("../assets/images/cards/card-7.png"),
  },
  {
    id: 8,
    name: "La Roue",
    theme: "Cycles",
    symbol: "⊕",
    upright: "Changement, cycles, chance, destin, karma positif",
    reversed: "Résistance au changement, malchance, cycles négatifs",
    color: "#A87CC8",
    image: require("../assets/images/cards/card-8.png"),
  },
  {
    id: 9,
    name: "La Force",
    theme: "Courage",
    symbol: "∞",
    upright: "Courage intérieur, patience, maîtrise de soi, compassion",
    reversed: "Doute de soi, faiblesse intérieure, impulsivité",
    color: "#C84C4C",
    image: require("../assets/images/cards/card-9.png"),
  },
  {
    id: 10,
    name: "L'Hermite",
    theme: "Sagesse",
    symbol: "☿",
    upright: "Introspection, guidance intérieure, solitude, sagesse, retraite",
    reversed: "Isolement néfaste, refus de guidance, solitude subie",
    color: "#7CC8A8",
    image: require("../assets/images/cards/card-10.png"),
  },
  {
    id: 11,
    name: "Le Jugement",
    theme: "Éveil",
    symbol: "⊿",
    upright: "Réveil spirituel, renouveau, absolution, appel intérieur",
    reversed: "Déni, jugement sévère de soi, refus de changement",
    color: "#C8B07C",
    image: require("../assets/images/cards/card-11.png"),
  },
  {
    id: 12,
    name: "Le Monde",
    theme: "Complétude",
    symbol: "◎",
    upright: "Achèvement, intégration, accomplissement, totalité, voyage",
    reversed: "Inachèvement, manque de clôture, stagnation finale",
    color: "#8BC8A0",
    image: require("../assets/images/cards/card-12.png"),
  },
];

export const POSITIONS = ["Passé", "Présent", "Avenir"] as const;
export type Position = (typeof POSITIONS)[number];

export const TONES = ["Direct", "Doux", "Mystique", "Pragmatique"] as const;
export type Tone = (typeof TONES)[number];

export function drawThreeCards(): Array<TarotCard & { position: Position; isReversed: boolean }> {
  const shuffled = [...TAROT_CARDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).map((card, i) => ({
    ...card,
    position: POSITIONS[i],
    isReversed: Math.random() > 0.7,
  }));
}
