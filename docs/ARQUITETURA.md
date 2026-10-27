# Arquitetura inicial

## Objetivo

O projeto não substitui o sistema de ponto IPM. Ele atua somente como ponte entre o controlador de acesso/frequência e a importação de registros no IPM.

## Fluxo

1. Controlador Hikvision registra autenticações.
2. Eventos são consultados pela ISAPI.
3. O campo de status de frequência (`attendanceStatus`) é usado para classificar o evento.
4. Eventos de acesso ficam armazenados, mas não entram na exportação de ponto.
5. Eventos de frequência são associados ao funcionário.
6. O usuário confere as marcações.
7. O sistema gera arquivo no layout do IPM.

## Pendência crítica

Ainda não existe, nos materiais fornecidos, o layout oficial do arquivo aceito pela tela **Importar Registro Ponto → Funcionário/Contrato** do IPM.

Portanto, o exportador definitivo deverá ser implementado somente depois de obter:

- arquivo de exemplo já aceito pelo IPM; ou
- documentação oficial do layout; ou
- orientação técnica formal da IPM.

Não será simulado layout de outro fabricante.
