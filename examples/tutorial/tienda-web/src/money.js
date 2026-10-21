/** Formatea centavos como dólares: 123456 → "$1,234.56". Los negativos llevan el signo delante: "-$1.50". */
export function formatCents(cents) {
  if (!Number.isInteger(cents)) throw new Error(`importe inválido: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}
