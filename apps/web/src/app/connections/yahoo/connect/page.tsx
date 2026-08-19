import type { Metadata } from "next";

import { YahooNativeConnect } from "../../../../components/yahoo-native-connect";
import { yahooComingSoon } from "../../../../lib/public-site";

export const metadata: Metadata = {
  title: "Connect Yahoo",
  description: "Continue a Laces Out iOS Yahoo connection in the system browser.",
  robots: { index: false, follow: false },
};

export default function YahooNativeConnectPage() {
  return <YahooNativeConnect enabled={!yahooComingSoon} />;
}
