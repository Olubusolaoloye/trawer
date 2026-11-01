/** Market Light for the till: same tokens as the web app (see the design canvas). */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';

export const colors = {
  ink: '#0E1411', ink2: '#1E241F', paper: '#FAF7F0', line: '#E4DED2', lineSoft: '#F0EBE1', muted: '#5B5F57', body: '#3E433C',
  green: '#0B7A4B', greenInk: '#075C38', green50: '#E3F2EA',
  indigo: '#23308C', indigo50: '#E8EAF7',
  gold: '#F2B705', goldInk: '#6B4600', gold50: '#FDF3CC',
  red: '#C8261B', redInk: '#9A1C13', red50: '#FBE7E4',
  // legacy names used across screens
  brand: '#0B7A4B', bg: '#FAF7F0', danger: '#C8261B', warn: '#8A5A00', good: '#075C38',
};

export const fonts = {
  display: 'BricolageGrotesque_800ExtraBold',
  displayBold: 'BricolageGrotesque_700Bold',
  body: 'Inter_400Regular',
  semi: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  black: 'Inter_800ExtraBold',
};

type Variant = 'primary' | 'secondary' | 'danger' | 'ink' | 'gold';
const VARIANT: Record<Variant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: colors.green, fg: '#fff' },
  ink: { bg: colors.ink, fg: '#fff' },
  gold: { bg: colors.gold, fg: colors.ink },
  danger: { bg: colors.red, fg: '#fff' },
  secondary: { bg: '#fff', fg: colors.ink, border: colors.ink },
};

export function Button({ title, onPress, variant = 'primary', disabled, pending, style, big }: {
  title: string; onPress: () => void; variant?: Variant; disabled?: boolean; pending?: boolean; style?: ViewStyle; big?: boolean;
}) {
  const v = VARIANT[variant];
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || pending }} disabled={disabled || pending} onPress={onPress}
      style={({ pressed }) => [s.button, big && { minHeight: 64, borderRadius: 18 }, { backgroundColor: v.bg, opacity: disabled ? 0.5 : pressed ? 0.88 : 1, borderWidth: v.border ? 2 : 0, borderColor: v.border }, style]}>
      {pending ? <ActivityIndicator color={v.fg} /> : <Text style={[s.buttonText, big && { fontSize: 20 }, { color: v.fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, dashed }: { label: string; selected?: boolean; onPress: () => void; dashed?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={{ minHeight: 48, paddingHorizontal: 18, borderRadius: 24, justifyContent: 'center', borderWidth: 2,
        borderStyle: dashed ? 'dashed' : 'solid', borderColor: selected ? colors.green : dashed ? colors.muted : colors.line, backgroundColor: selected ? colors.green : dashed ? 'transparent' : '#fff' }}>
      <Text style={{ fontFamily: selected ? fonts.black : fonts.bold, fontSize: 15, color: selected ? '#fff' : colors.ink }}>{label}</Text>
    </Pressable>
  );
}

/** Always-visible sync state: Live / Offline · n saved / n to fix. */
export function SyncPill({ tone, label }: { tone: 'live' | 'offline' | 'fix'; label: string }) {
  const t = { live: [colors.green50, colors.greenInk, colors.green], offline: [colors.gold50, colors.goldInk, colors.gold], fix: [colors.red50, colors.redInk, colors.red] }[tone];
  return (
    <View accessibilityRole="text" accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: t[0] }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t[2] }} />
      <Text style={{ fontFamily: fonts.black, fontSize: 14, color: t[1] }}>{label}</Text>
    </View>
  );
}

export function Field({ label, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} style={s.input} {...rest} />
    </View>
  );
}

export function Card({ children, style, strong }: { children: ReactNode; style?: ViewStyle; strong?: boolean }) {
  return <View style={[s.card, strong && { borderWidth: 2, borderColor: colors.ink }, style]}>{children}</View>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <Text accessibilityRole="alert" style={{ color: colors.redInk, fontFamily: fonts.semi, backgroundColor: colors.red50, padding: 12, borderRadius: 12 }}>{error}</Text> : null;
}

export const s = StyleSheet.create({
  button: { minHeight: 56, borderRadius: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 17, fontFamily: fonts.black },
  label: { fontSize: 15, fontFamily: fonts.bold, color: colors.ink },
  input: { minHeight: 56, borderWidth: 2, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 16, fontSize: 18, fontFamily: fonts.semi, backgroundColor: '#fff', color: colors.ink },
  card: { backgroundColor: '#fff', borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 14 },
  h1: { fontSize: 28, fontFamily: fonts.display, color: colors.ink, letterSpacing: -0.5 },
  h2: { fontSize: 20, fontFamily: fonts.display, color: colors.ink },
  money: { fontFamily: fonts.display, color: colors.ink, fontVariant: ['tabular-nums'] },
  muted: { color: colors.muted, fontSize: 15, fontFamily: fonts.body },
  body: { color: colors.ink, fontSize: 16, fontFamily: fonts.body },
});
