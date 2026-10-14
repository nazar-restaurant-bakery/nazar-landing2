import assert from 'node:assert/strict';
import test from 'node:test';
import {isTestLead} from '../src/lib/testLead.ts';
test('explicit markers are case insensitive and bounded',()=>{
 for(const email of ['a@example.com','a@EXAMPLE.NET','a@example.org','a@sub.invalid','a@invalid']) assert.equal(isTestLead({email}),true,email);
 assert.equal(isTestLead({name:' INTERNAL TEST phone-only '}),true);
 for(const item of [{name:'Testerman',email:'a@customer-mail.com'},{name:'INTERNAL TESTIMONY'},{email:'a@example.com.customer-mail.com'},{email:'a@notinvalid.com'}]) assert.equal(isTestLead(item),false);
});
