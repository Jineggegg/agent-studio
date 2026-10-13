import {
  Bot,
  Box,
  Briefcase,
  BookOpen,
  Camera,
  ChartLine,
  Code,
  Compass,
  Database,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  Leaf,
  Lightbulb,
  type LucideIcon,
  Music,
  Palette,
  PenTool,
  Rocket,
  Server,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-react';

/**
 * The symbols a project can wear. The server stores only the name; a name
 * this client does not know (a newer client chose it) falls back to "folder".
 */
export const PROJECT_SYMBOLS = {
  folder: Folder,
  code: Code,
  terminal: Terminal,
  globe: Globe,
  smartphone: Smartphone,
  server: Server,
  database: Database,
  bot: Bot,
  sparkles: Sparkles,
  rocket: Rocket,
  flask: FlaskConical,
  wrench: Wrench,
  box: Box,
  chart: ChartLine,
  book: BookOpen,
  pen: PenTool,
  palette: Palette,
  camera: Camera,
  music: Music,
  gamepad: Gamepad2,
  cart: ShoppingCart,
  briefcase: Briefcase,
  graduation: GraduationCap,
  lightbulb: Lightbulb,
  compass: Compass,
  leaf: Leaf,
  zap: Zap,
  heart: Heart,
} as const satisfies Record<string, LucideIcon>;

export type ProjectSymbol = keyof typeof PROJECT_SYMBOLS;
export const PROJECT_SYMBOL_NAMES = Object.keys(PROJECT_SYMBOLS) as ProjectSymbol[];

export function projectSymbol(name: string): LucideIcon {
  return (PROJECT_SYMBOLS as Record<string, LucideIcon>)[name] ?? Folder;
}
