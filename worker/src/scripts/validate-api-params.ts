/**
 * API Parameter Validation Script
 * 
 * Validates that Tradier API calls match the expected format.
 * Checks for common issues like missing parameters, wrong values, etc.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

function validateTradierCalls() {
  const brokerPath = join(__dirname, '../broker/tradierClient.ts');
  const content = readFileSync(brokerPath, 'utf-8');
  
  console.log('🔍 Validating Tradier API calls...\n');
  
  let errors = 0;
  const warnings: string[] = [];
  
  // Check placeSpreadOrder for required parameters
  if (content.includes('placeSpreadOrder')) {
    const placeOrderMatch = content.match(/placeSpreadOrder[\s\S]*?async\s+placeSpreadOrder[\s\S]*?\{[\s\S]*?\}/);
    
    if (placeOrderMatch) {
      const methodContent = placeOrderMatch[0];
      
      // Check for 'class' parameter
      if (!methodContent.includes("body.append('class'")) {
        console.error('❌ placeSpreadOrder: Missing "class" parameter');
        errors++;
      } else {
        // Check if it's 'multileg' (correct for multi-leg orders)
        if (methodContent.includes("body.append('class', 'multileg'")) {
          console.log('✅ placeSpreadOrder: class=multileg (correct)');
        } else {
          warnings.push('⚠️  placeSpreadOrder: class parameter may be incorrect');
        }
      }
      
      // Check for 'type' parameter
      if (!methodContent.includes("body.append('type'")) {
        console.error('❌ placeSpreadOrder: Missing "type" parameter');
        errors++;
      } else if (methodContent.includes("body.append('type', 'limit'")) {
        console.log('✅ placeSpreadOrder: type=limit (correct for multileg limit orders)');
      } else {
        console.error('❌ placeSpreadOrder: type must be set to "limit" for multileg orders');
        errors++;
      }
      
      // Check for 'tag' parameter format (no underscores)
      if (methodContent.includes("tag=GEKKOWORKS_ENTRY") || methodContent.includes("tag=GEKKOWORKS_EXIT")) {
        console.error('❌ placeSpreadOrder: tag contains underscores (should use hyphens)');
        errors++;
      } else if (methodContent.includes("tag=GEKKOWORKS-ENTRY") || methodContent.includes("tag=GEKKOWORKS-EXIT")) {
        console.log('✅ placeSpreadOrder: tag format uses hyphens (correct)');
      }
      
      // Check for URL encoding
      if (methodContent.includes('encodeURIComponent')) {
        console.log('✅ placeSpreadOrder: URL encoding present');
      } else {
        warnings.push('⚠️  placeSpreadOrder: May need URL encoding for parameters');
      }
    }
  }
  
  // Check getOptionChain for URL encoding
  if (content.includes('getOptionChain')) {
    if (content.includes('encodeURIComponent(symbol)') && content.includes('encodeURIComponent(expiration)')) {
      console.log('✅ getOptionChain: URL encoding present');
    } else {
      warnings.push('⚠️  getOptionChain: May need URL encoding');
    }
  }
  
  // Check getOrder for URL encoding
  if (content.includes('getOrder')) {
    if (content.includes('encodeURIComponent(orderId)') || content.includes('encodeURIComponent(order')) {
      console.log('✅ getOrder: URL encoding present');
    } else {
      warnings.push('⚠️  getOrder: May need URL encoding');
    }
  }
  
  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => console.log(`   ${w}`));
  }
  
  if (errors > 0) {
    console.error(`\n❌ Found ${errors} validation error(s). Fix before deploying!`);
    process.exit(1);
  } else {
    console.log('\n✅ All API parameter validations passed!');
  }
}

validateTradierCalls();

