const nodemailer = require('nodemailer') as any;

export function isGmailConfigured(): boolean {
  return !!process.env.GMAIL_SMTP_USER?.trim()
    && !!process.env.GMAIL_APP_PASSWORD?.trim();
}

export async function sendPasswordRecoveryEmail(
  destination: string,
  name: string,
  code: string
): Promise<void> {
  const user = process.env.GMAIL_SMTP_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.trim();

  if (!user || !pass) {
    throw new Error('GMAIL_RECOVERY_NOT_CONFIGURED');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });

  const fromName = process.env.GMAIL_FROM_NAME?.trim()
    || 'Câmara Municipal de Três Barras';

  await transporter.sendMail({
    from: `"${fromName.replaceAll('"', '')}" <${user}>`,
    to: destination,
    subject: 'Código para redefinir a senha · Ponto Eletrônico',
    text: [
      `Olá, ${name}.`,
      '',
      `Seu código para redefinir a senha do Ponto Eletrônico é: ${code}`,
      '',
      'O código expira em 15 minutos e pode ser usado uma única vez.',
      'Se você não solicitou a alteração, ignore esta mensagem.',
      '',
      'Câmara Municipal de Três Barras'
    ].join('\n')
  });
}
