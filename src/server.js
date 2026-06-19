require('dotenv').config();
const express = require('express');
const { CloudflareDNS } = require('./dnsService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const dns = new CloudflareDNS(
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_EMAIL
);

function isValidIP(ip) {
  const ipv4Pattern = /^((25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
  return ipv4Pattern.test(ip);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'DNS A Record Updater API is running' });
});

app.post('/api/dns/a-record', async (req, res) => {
  try {
    const { subdomain, domain, ip, ttl = 1, proxied = false } = req.body;

    if (!domain) {
      return res.status(400).json({
        success: false,
        error: 'domain is required'
      });
    }

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: 'ip is required'
      });
    }

    if (!isValidIP(ip)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid IPv4 address format'
      });
    }

    const result = await dns.upsertARecord(subdomain, domain, ip, ttl, proxied);

    res.json({
      success: true,
      data: {
        domain,
        fullDomain: subdomain ? `${subdomain}.${domain}` : domain,
        ip,
        action: result.action,
        recordId: result.record.id
      }
    });

  } catch (error) {
    console.error('Error updating A record:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/dns/a-record', async (req, res) => {
  try {
    const { subdomain, domain } = req.query;

    if (!domain) {
      return res.status(400).json({
        success: false,
        error: 'domain is required'
      });
    }

    const zoneId = await dns.getZoneId(domain);
    const record = await dns.getARecordId(zoneId, subdomain, domain);

    if (record) {
      return res.json({
        success: true,
        data: {
          domain,
          fullDomain: subdomain ? `${subdomain}.${domain}` : domain,
          type: record.type,
          ip: record.content,
          ttl: record.ttl,
          proxied: record.proxied,
          recordId: record.id
        }
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'A record not found'
      });
    }

  } catch (error) {
    console.error('Error getting A record:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('API Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /api/dns/a-record?domain=example.com&subdomain=www');
  console.log('  POST /api/dns/a-record');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please set a different PORT in .env file.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

module.exports = app;
