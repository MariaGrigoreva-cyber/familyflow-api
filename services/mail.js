const axios = require('axios');

async function sendWelcomeEmail(email) {
  try {
    await axios.post(
      'https://go1.unisender.ru/ru/transactional/api/v1/email/send.json',
      {
        message: {
          recipients: [
            { email }
          ],
          subject: 'Добро пожаловать в FamilyFlow!',
          from_email: process.env.MAIL_FROM_EMAIL,
          from_name: process.env.EMAIL_FROM_NAME,
          body: {
            html: `
              <h2>Добро пожаловать!</h2>
              <p>Спасибо за регистрацию в FamilyFlow.</p>
              <p>Теперь вы можете:</p>
              <ul>
                <li>вести семейный бюджет;</li>
                <li>планировать расходы;</li>
                <li>контролировать накопления.</li>
              </ul>
              <p>Желаем успешного финансового планирования!</p>
            `,
          },
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-KEY': process.env.UNISENDER_API_KEY,
        },
      }
    );

    console.log('Email sent:', email);

  } catch (err) {
    console.error(
      'Mail error:',
      err.response?.data || err.message
    );
  }
}

module.exports = {
  sendWelcomeEmail
};
