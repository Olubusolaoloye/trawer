/** Market Light v2 for the till: same tokens and feel as the web app (soft depth, motion, icons). */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type PressableProps, type TextInputProps, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LucideProps } from 'lucide-react-native';

export const colors = {
  ink: '#0E1411', ink2: '#1E241F', paper: '#FAF7F0', surface: '#FFFFFF', line: '#E4DED2', lineSoft: '#F0EBE1', muted: '#5B5F57', body: '#3E433C',
  onInk: '#E7E2D6', onInkMuted: '#A9A497',
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

export const radius = { sm: 10, md: 14, lg: 20, xl: 26, pill: 999 };

/** Soft, layered elevation (iOS shadow + Android elevation). */
export const shadow = {
  card: { shadowColor: '#0E1411', shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 2 },
  lift: { shadowColor: '#0E1411', shadowOpacity: 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 6 },
  float: { shadowColor: '#0E1411', shadowOpacity: 0.28, shadowRadius: 30, shadowOffset: { width: 0, height: 18 }, elevation: 12 },
  green: { shadowColor: '#0B7A4B', shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 10 }, elevation: 5 },
} satisfies Record<string, ViewStyle>;

export type Icon = ComponentType<LucideProps>;

export function tap(kind: 'light' | 'medium' | 'success' | 'warning' = 'light') {
  if (Platform.OS === 'web') return;
  if (kind === 'success' || kind === 'warning') void Haptics.notificationAsync(kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  else void Haptics.impactAsync(kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** Pressable that springs down a little when pressed (with a light haptic). Layout styles apply to the pressable itself. */
const APressable = Animated.createAnimatedComponent(Pressable);
export function Press({ style, children, onPress, haptic = true, scaleTo = 0.97, ...rest }: Omit<PressableProps, 'style' | 'children'> & { style?: ViewStyle | ViewStyle[]; children: ReactNode; haptic?: boolean; scaleTo?: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(scale, { toValue: v, useNativeDriver: Platform.OS !== 'web', speed: 40, bounciness: 6 }).start();
  return (
    <APressable {...rest} onPressIn={() => to(scaleTo)} onPressOut={() => to(1)} onPress={(e: Parameters<NonNullable<PressableProps['onPress']>>[0]) => { if (haptic) tap(); onPress?.(e); }}
      style={[...(Array.isArray(style) ? style : [style]), { transform: [{ scale }] }]}>
      {children}
    </APressable>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ink' | 'gold' | 'soft';
const VARIANT: Record<Variant, { bg: string; fg: string; border?: string; glow?: ViewStyle }> = {
  primary: { bg: colors.green, fg: '#fff', glow: shadow.green },
  ink: { bg: colors.ink, fg: colors.paper, glow: shadow.lift },
  gold: { bg: colors.gold, fg: colors.ink },
  danger: { bg: colors.red, fg: '#fff' },
  secondary: { bg: colors.surface, fg: colors.ink, border: 'rgba(14,20,17,0.85)' },
  soft: { bg: colors.lineSoft, fg: colors.ink },
};

export function Button({ title, onPress, variant = 'primary', disabled, pending, style, big, icon: IconC, accessibilityLabel }: {
  title: string; onPress: () => void; variant?: Variant; disabled?: boolean; pending?: boolean; style?: ViewStyle; big?: boolean; icon?: Icon; accessibilityLabel?: string;
}) {
  const v = VARIANT[variant];
  const off = disabled || pending;
  return (
    <Press accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled: off, busy: pending }} disabled={off} onPress={onPress}
      style={[s.button, big ? { minHeight: 66, borderRadius: radius.lg } : {}, { backgroundColor: v.bg, borderWidth: v.border ? 1.5 : 0, borderColor: v.border, opacity: disabled ? 0.45 : 1 }, !off && v.glow ? v.glow : {}, style ?? {}]}>
      {pending ? <ActivityIndicator color={v.fg} /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {IconC && <IconC size={big ? 22 : 19} color={v.fg} strokeWidth={2.4} />}
          <Text style={[s.buttonText, big && { fontSize: 20 }, { color: v.fg }]} numberOfLines={1}>{title}</Text>
        </View>
      )}
    </Press>
  );
}

export function IconButton({ icon: IconC, label, onPress, tone = 'light', size = 48 }: { icon: Icon; label: string; onPress: () => void; tone?: 'light' | 'ink' | 'onInk'; size?: number }) {
  const bg = tone === 'ink' ? colors.ink : tone === 'onInk' ? 'rgba(255,255,255,0.1)' : colors.surface;
  const fg = tone === 'light' ? colors.ink : colors.paper;
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={[{ width: size, height: size, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: bg }, tone === 'light' ? { borderWidth: 1, borderColor: colors.line } : {}]}>
      <IconC size={22} color={fg} strokeWidth={2.2} />
    </Press>
  );
}

export function Chip({ label, selected, onPress, dashed, count, icon: IconC }: { label: string; selected?: boolean; onPress: () => void; dashed?: boolean; count?: number; icon?: Icon }) {
  return (
    <Press accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={{ minHeight: 46, paddingHorizontal: 16, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', gap: 8,
        borderWidth: selected ? 0 : 1.5, borderStyle: dashed ? 'dashed' : 'solid', borderColor: dashed ? colors.muted : colors.line,
        backgroundColor: selected ? colors.ink : dashed ? 'transparent' : colors.surface }}>
      {IconC && <IconC size={17} color={selected ? colors.paper : colors.ink} strokeWidth={2.4} />}
      <Text style={{ fontFamily: selected ? fonts.black : fonts.bold, fontSize: 15, color: selected ? colors.paper : colors.ink }}>{label}</Text>
      {count !== undefined && (
        <View style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? colors.gold : colors.lineSoft }}>
          <Text style={{ fontFamily: fonts.black, fontSize: 12, color: colors.ink }}>{count}</Text>
        </View>
      )}
    </Press>
  );
}

/** Always-visible sync state: Live / Offline · n saved / n to fix. The live dot breathes. */
export function SyncPill({ tone, label, onInk }: { tone: 'live' | 'offline' | 'fix'; label: string; onInk?: boolean }) {
  const t = {
    live: onInk ? ['rgba(11,122,75,0.22)', '#9BE3BE', '#3DDC97'] : [colors.green50, colors.greenInk, colors.green],
    offline: onInk ? ['rgba(242,183,5,0.18)', '#FFD866', colors.gold] : [colors.gold50, colors.goldInk, colors.gold],
    fix: onInk ? ['rgba(200,38,27,0.25)', '#FFB3AB', '#FF6B5E'] : [colors.red50, colors.redInk, colors.red],
  }[tone];
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (tone !== 'live') return;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== 'web' }));
    loop.start();
    return () => loop.stop();
  }, [tone, pulse]);
  return (
    <View accessibilityRole="text" accessibilityLabel={label} accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: t[0] }}>
      <View style={{ width: 10, height: 10 }}>
        {tone === 'live' && <Animated.View style={{ position: 'absolute', inset: 0, borderRadius: 5, backgroundColor: t[2], opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }] }} />}
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t[2] }} />
      </View>
      <Text style={{ fontFamily: fonts.black, fontSize: 14, color: t[1] }}>{label}</Text>
    </View>
  );
}

export function Field({ label, hint, ...rest }: TextInputProps & { label: string; hint?: string }) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} {...rest}
        onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }} onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
        style={[s.input, focus && s.inputFocus, rest.style]} />
      {hint ? <Text style={[s.muted, { fontSize: 13 }]}>{hint}</Text> : null}
    </View>
  );
}

/** Search box with an icon, matching the web storefront search. */
export function SearchBox({ icon: IconC, ...rest }: TextInputProps & { icon: Icon }) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={[s.input, { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }, focus && s.inputFocus, rest.style as ViewStyle]}>
      <IconC size={20} color={colors.muted} strokeWidth={2.2} />
      <TextInput placeholderTextColor={colors.muted} {...rest} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{ flex: 1, fontSize: 17, fontFamily: fonts.semi, color: colors.ink, minHeight: 50, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as object : {}) }} />
    </View>
  );
}

export function Card({ children, style, strong, flat }: { children: ReactNode; style?: ViewStyle; strong?: boolean; flat?: boolean }) {
  return <View style={[s.card, !flat && shadow.card, strong && { borderWidth: 1.5, borderColor: colors.ink }, style]}>{children}</View>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <Text accessibilityRole="alert" style={{ color: colors.redInk, fontFamily: fonts.semi, backgroundColor: colors.red50, padding: 12, borderRadius: radius.md, overflow: 'hidden' }}>{error}</Text> : null;
}

/** On/off switch (accessible, with a sliding knob). */
export function Toggle({ label, hint, value, onChange, icon: IconC }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; icon?: Icon }) {
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => { Animated.timing(x, { toValue: value ? 1 : 0, duration: 180, useNativeDriver: false }).start(); }, [value, x]);
  return (
    <Press accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} onPress={() => onChange(!value)} scaleTo={0.99}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8 }}>
      {IconC && <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.lineSoft, alignItems: 'center', justifyContent: 'center' }}><IconC size={20} color={colors.ink} /></View>}
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.ink }}>{label}</Text>
        {hint ? <Text style={[s.muted, { fontSize: 13 }]}>{hint}</Text> : null}
      </View>
      <Animated.View style={{ width: 52, height: 32, borderRadius: 16, padding: 3, backgroundColor: x.interpolate({ inputRange: [0, 1], outputRange: [colors.line, colors.green] }) }}>
        <Animated.View style={[{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff' }, shadow.card, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] }]} />
      </Animated.View>
    </Press>
  );
}

/** Soft radial glow for ink surfaces (green + gold, like the web dashboard hero). */
export function Glow({ id = 'g', tone = 'green' }: { id?: string; tone?: 'green' | 'gold' }) {
  const c = tone === 'green' ? '#0B7A4B' : '#F2B705';
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}a`} cx="100" cy="0" r="80" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={c} stopOpacity="0.55" /><Stop offset="1" stopColor={c} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`${id}b`} cx="0" cy="100" r="60" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#F2B705" stopOpacity="0.14" /><Stop offset="1" stopColor="#F2B705" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="100" height="100" fill={`url(#${id}a)`} />
      <Rect width="100" height="100" fill={`url(#${id}b)`} />
    </Svg>
  );
}

/** Bottom sheet on phones, centred dialog on tablets. Slides + fades in. */
export function Sheet({ visible, onClose, children, title, wide }: { visible: boolean; onClose: () => void; children: ReactNode; title?: string; wide?: boolean }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tablet = width >= 900;
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => { if (visible) { y.setValue(0); Animated.spring(y, { toValue: 1, useNativeDriver: Platform.OS !== 'web', speed: 16, bounciness: 4 }).start(); } }, [visible, y]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: 'rgba(14,20,17,0.55)', justifyContent: tablet ? 'center' : 'flex-end', padding: tablet ? 24 : 0 }}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={onClose} />
        <Animated.View style={[{ backgroundColor: colors.paper, maxHeight: '92%', width: '100%', alignSelf: 'center', maxWidth: tablet ? (wide ? 760 : 520) : undefined,
          borderRadius: tablet ? radius.xl : 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingBottom: tablet ? 0 : insets.bottom, overflow: 'hidden' }, shadow.float,
          { opacity: y, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [tablet ? 24 : 120, 0] }) }] }]}>
          {!tablet && <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.line, marginTop: 10 }} />}
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 14 }}>
            {title ? <Text accessibilityRole="header" style={s.h1}>{title}</Text> : null}
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A row in a grouped list (settings, pickers). */
export function Row({ icon: IconC, title, subtitle, right, onPress, tint }: { icon?: Icon; title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; tint?: string }) {
  const body = (
    <>
      {IconC && <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: tint ?? colors.lineSoft, alignItems: 'center', justifyContent: 'center' }}><IconC size={21} color={tint ? '#fff' : colors.ink} strokeWidth={2.2} /></View>}
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.ink }} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[s.muted, { fontSize: 13 }]} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right}
    </>
  );
  const st: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10, paddingHorizontal: 14 };
  return onPress ? <Press accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={st} scaleTo={0.985}>{body}</Press> : <View style={st}>{body}</View>;
}

export const s = StyleSheet.create({
  button: { minHeight: 56, borderRadius: radius.md, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 17, fontFamily: fonts.black },
  label: { fontSize: 15, fontFamily: fonts.bold, color: colors.ink },
  input: { minHeight: 54, borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 16, fontSize: 17, fontFamily: fonts.semi, backgroundColor: colors.surface, color: colors.ink },
  inputFocus: { borderColor: colors.ink, backgroundColor: '#fff', shadowColor: '#0E1411', shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(228,222,210,0.7)', padding: 14 },
  h1: { fontSize: 28, fontFamily: fonts.display, color: colors.ink, letterSpacing: -0.6 },
  h2: { fontSize: 20, fontFamily: fonts.display, color: colors.ink, letterSpacing: -0.3 },
  money: { fontFamily: fonts.display, color: colors.ink, fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  muted: { color: colors.muted, fontSize: 15, fontFamily: fonts.body },
  body: { color: colors.ink, fontSize: 16, fontFamily: fonts.body },
  eyebrow: { color: colors.muted, fontSize: 12, fontFamily: fonts.black, letterSpacing: 1, textTransform: 'uppercase' },
});
