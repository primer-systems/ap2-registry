/**
 * AP2 Intent Mandate Registry API
 *
 * POST /api/mandates - Store or replace a mandate
 * GET /api/mandates?id={id} - Retrieve a mandate by ID
 * GET /api/mandates?agent_id={id} - Retrieve mandates by agent ID
 *
 * Environment variables:
 * - SUPABASE_URL: Your Supabase project URL
 * - SUPABASE_SERVICE_ROLE_KEY: Service role key for server-side access
 */

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).json({});
  }

  // Set CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  try {
    if (req.method === 'POST') {
      return await handlePost(req, res);
    } else if (req.method === 'GET') {
      return await handleGet(req, res);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Validation helpers
const AGENT_ID_PATTERN = /^[A-Z0-9]{3,8}$/;
const ETH_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const CAIP2_PATTERN = /^eip155:\d+$/;
const NAMED_NETWORKS = ['skale-base', 'skale-base-sepolia', 'base', 'base-sepolia', 'ethereum', 'arbitrum', 'optimism', 'polygon'];
const MAX_PAYLOAD_SIZE = 50 * 1024; // 50KB

function validateNetwork(network) {
  if (typeof network !== 'string') return false;
  return CAIP2_PATTERN.test(network) || NAMED_NETWORKS.includes(network.toLowerCase());
}

async function handlePost(req, res) {
  const mandate = req.body;

  // Check payload size (approximate since body is already parsed)
  const payloadSize = JSON.stringify(mandate).length;
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    return res.status(413).json({
      error: `Payload too large (${payloadSize} bytes, max ${MAX_PAYLOAD_SIZE})`,
      code: 'PAYLOAD_TOO_LARGE'
    });
  }

  // Validate required fields
  if (!mandate || !mandate.type || mandate.type !== 'IntentMandate') {
    return res.status(400).json({
      error: 'Invalid mandate: must be an Intent Mandate object',
      code: 'INVALID_MANDATE'
    });
  }

  if (!mandate.agent?.id) {
    return res.status(400).json({
      error: 'Invalid mandate: missing agent.id',
      code: 'MISSING_AGENT_ID'
    });
  }

  // Validate agent ID format
  if (!AGENT_ID_PATTERN.test(mandate.agent.id)) {
    return res.status(400).json({
      error: 'Invalid agent.id: must be 3-8 uppercase alphanumeric characters',
      code: 'INVALID_AGENT_ID'
    });
  }

  // Validate wallet address format if provided
  if (mandate.wallet?.address && !ETH_ADDRESS_PATTERN.test(mandate.wallet.address)) {
    return res.status(400).json({
      error: 'Invalid wallet.address: must be valid Ethereum address (0x + 40 hex chars)',
      code: 'INVALID_WALLET_ADDRESS'
    });
  }

  // Validate signer address format if provided
  if (mandate.signature?.signer && !ETH_ADDRESS_PATTERN.test(mandate.signature.signer)) {
    return res.status(400).json({
      error: 'Invalid signature.signer: must be valid Ethereum address',
      code: 'INVALID_SIGNER_ADDRESS'
    });
  }

  // Validate networks array if provided
  const networks = mandate.authorization?.networks || [];
  if (!Array.isArray(networks)) {
    return res.status(400).json({
      error: 'Invalid authorization.networks: must be an array',
      code: 'INVALID_NETWORKS'
    });
  }
  for (const network of networks) {
    if (!validateNetwork(network)) {
      return res.status(400).json({
        error: `Invalid network: ${network}. Must be CAIP-2 format (eip155:CHAINID) or a supported network name`,
        code: 'INVALID_NETWORK'
      });
    }
  }

  // Validate daily limit if provided
  const dailyLimit = mandate.authorization?.limits?.dailyLimit;
  if (dailyLimit !== undefined && dailyLimit !== null) {
    if (typeof dailyLimit !== 'number' || dailyLimit < 0 || dailyLimit > 10**15) {
      return res.status(400).json({
        error: 'Invalid dailyLimit: must be non-negative number less than 10^15',
        code: 'INVALID_DAILY_LIMIT'
      });
    }
  }

  // Use the mandate's ID if provided, otherwise generate one
  const mandateId = mandate.id || crypto.randomUUID();

  // Extract key fields for indexing
  const record = {
    id: mandateId,
    agent_id: mandate.agent.id,
    agent_name: mandate.agent.name || null,
    agent_public_key: mandate.agent.publicKey || null,
    policy_name: mandate.authorization?.policyName || null,
    wallet_address: mandate.wallet?.address || null,
    daily_limit_cents: mandate.authorization?.limits?.dailyLimitCents || null,
    networks: mandate.authorization?.networks || [],
    data: mandate,
    issued_at: mandate.issuedAt || new Date().toISOString(),
    signature: mandate.signature?.value || null,
    signer_address: mandate.signature?.signer || null,
  };

  // A mandate belongs to the wallet that signed it, and only that wallet may
  // replace it.
  const { data: existing, error: lookupError } = await supabase
    .from('mandates')
    .select('signer_address')
    .eq('id', mandateId)
    .maybeSingle();

  if (lookupError) {
    console.error('Supabase error:', lookupError);
    return res.status(500).json({
      error: 'Failed to store mandate',
      code: 'STORAGE_ERROR'
    });
  }

  if (existing) {
    const storedSigner = existing.signer_address;
    const newSigner = record.signer_address;

    // An unsigned record has no owner to match against.
    if (!storedSigner || !newSigner ||
        storedSigner.toLowerCase() !== newSigner.toLowerCase()) {
      return res.status(403).json({
        error: 'This mandate ID already exists and is held by a different signer',
        code: 'SIGNER_MISMATCH'
      });
    }

    // Filtering on signer_address applies the ownership check atomically.
    const { data, error } = await supabase
      .from('mandates')
      .update(record)
      .eq('id', mandateId)
      .eq('signer_address', storedSigner)
      .select('id')
      .single();

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({
        error: 'Failed to store mandate',
        code: 'STORAGE_ERROR'
      });
    }

    return res.status(200).json({
      id: data.id,
      url: `https://ap2.primer.systems/mandate?id=${data.id}`,
      message: 'Mandate updated successfully'
    });
  }

  const { data, error } = await supabase
    .from('mandates')
    .insert(record)
    .select('id')
    .single();

  if (error) {
    // 23505 = unique violation, from a concurrent insert of the same ID.
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'This mandate ID already exists',
        code: 'DUPLICATE_ID'
      });
    }
    console.error('Supabase error:', error);
    return res.status(500).json({
      error: 'Failed to store mandate',
      code: 'STORAGE_ERROR'
    });
  }

  return res.status(201).json({
    id: data.id,
    url: `https://ap2.primer.systems/mandate?id=${data.id}`,
    message: 'Mandate stored successfully'
  });
}

async function handleGet(req, res) {
  const { id, agent_id } = req.query;

  if (!id && !agent_id) {
    return res.status(400).json({
      error: 'Must provide id or agent_id query parameter',
      code: 'MISSING_QUERY'
    });
  }

  let query = supabase.from('mandates').select('*');

  if (id) {
    query = query.eq('id', id).single();
  } else if (agent_id) {
    query = query.eq('agent_id', agent_id).order('issued_at', { ascending: false });
  }

  const { data, error } = await query;

  if (error) {
    if (error.code === 'PGRST116') {
      return res.status(404).json({
        error: 'Mandate not found',
        code: 'NOT_FOUND'
      });
    }
    console.error('Supabase error:', error);
    return res.status(500).json({
      error: 'Failed to retrieve mandate',
      code: 'RETRIEVAL_ERROR'
    });
  }

  if (!data) {
    return res.status(404).json({
      error: 'Mandate not found',
      code: 'NOT_FOUND'
    });
  }

  // Return just the mandate data for single lookups
  if (id) {
    return res.status(200).json(data.data);
  }

  // Return array of mandates for agent lookups
  return res.status(200).json(data.map(row => row.data));
}
